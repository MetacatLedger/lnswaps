const zmq = require('zmq');
const bitcoinRpc = require('node-bitcoin-rpc');
const { mnemonicToSeed, validateMnemonic } = require('bip39');
const bip65Encode = require('bip65').encode;
const log4js = require('log4js');
const bitcoin = require('./tokenslib');
const { Transaction, networks } = require('./tokenslib');
const { HDNode, crypto } = require('./tokenslib');
const { redisClient, redisSub, updateRedisOrderAndPublish } = require('./service/redis_client.js');
const orderState = require('./service/order_state.js');

const logger = log4js.getLogger();
logger.level = 'all';

const BLOCK_HEIGHT_EXPIRATION = 60; // seconds
const BLOCK_HEIGHT_INTERVAL = 6000; // miliseconds
const FEE_ESTIMATION_EXPIRATION = 60; // seconds
const FEE_ESTIMATION_INTERVAL = 6000; // miliseconds

const DEC_BASE = 10;

const interestedAddrs = new Map(); // addr => ({token, invoice})
const interestedTxns = new Map(); // txid => (invoice)

const {
  LNSWAP_CHAIN, LNSWAP_CHAIN_RPC_API, LNSWAP_CLAIM_ADDRESS,
  LNSWAP_CLAIM_BIP39_SEED, LNSWAP_CHAIN_ZMQ_RAWBLOCK_URL, LNSWAP_CHAIN_ZMQ_RAWTX_URL,
} = process.env;

switch (LNSWAP_CHAIN) {
  case 'bitcoin':
  case 'testnet':
  case 'litecoin':
  case 'ltctestnet':
    break;

  default:
    logger.fatal('Unsupported blockchain:', LNSWAP_CHAIN);
    process.exit();
}
const bitcoinjsNetwork = networks[LNSWAP_CHAIN];
const [partA, partB] = LNSWAP_CHAIN_RPC_API.split('@');
const [rpcUsername, rpcPassword] = partA.split(':');
const [rpcHost, rpcPort] = partB.split(':');

if (!LNSWAP_CLAIM_ADDRESS) {
  logger.fatal('Please set variable LNSWAP_CLAIM_ADDRESS');
  process.exit();
}

if (!validateMnemonic(LNSWAP_CLAIM_BIP39_SEED)) {
  logger.fatal('ExpectedValidMnemonic');
  process.exit();
}
const seed = mnemonicToSeed(LNSWAP_CLAIM_BIP39_SEED);
const root = HDNode.fromSeedBuffer(seed, bitcoinjsNetwork);

const zmqRawBlockSocket = zmq.socket('sub');
const zmqRawTxSocket = zmq.socket('sub');

let currentBlockHeight = 0;

function getAddressesFromOuts(outs) {
  const outputAddresses = [];
  outs.forEach(({ script, value }, index) => {
    try {
      const address = bitcoin.address.fromOutputScript(script, bitcoinjsNetwork);
      outputAddresses.push({ address, tokens: value, index });
    } catch (e) {
      // OP_RETURN
      // logger.error('getAddressesFromOuts(): OP_RETURN');
    }
  });

  return outputAddresses;
}

// create claim transaction to claim fund
// TODO: calculate weight and txn fee
// TODO: batching claimning txns
function claimTransaction({
  invoice, onchainAmount, fundingTxnIndex, fundingTxn, redeemScript, swapKeyIndex, lnPreimage,
}) {
  const tx = new bitcoin.Transaction();
  // add output: claimAddress and (onchainAmount - txnFee)
  const scriptPubKey = bitcoin.address.toOutputScript(LNSWAP_CLAIM_ADDRESS, bitcoinjsNetwork);
  tx.addOutput(scriptPubKey, parseFloat(onchainAmount) * 100000000 - 1000);

  // add input: fundingTxn, fundingTxnIndex and sequence
  tx.addInput(Buffer.from(fundingTxn, 'hex').reverse(), parseInt(fundingTxnIndex, DEC_BASE));
  tx.ins[0].sequence = 0;

  // set locktime
  tx.locktime = bip65Encode({ blocks: currentBlockHeight });

  // set scriptSig
  const redeemBuf = Buffer.from(redeemScript, 'hex');
  // '22' => length, '00' => OP_0, '20' => len of sha256
  const witnessInput = Buffer.concat([Buffer.from('220020', 'hex'), crypto.sha256(redeemBuf)]);
  tx.setInputScript(0, witnessInput);

  // set witness data
  const { keyPair } = root.derivePath(`m/0'/0/${swapKeyIndex}`);
  const sigHash = tx.hashForWitnessV0(0, redeemBuf,
    parseFloat(onchainAmount, DEC_BASE) * 100000000, Transaction.SIGHASH_ALL);
  const signature = keyPair.sign(sigHash).toScriptSignature(Transaction.SIGHASH_ALL);
  const witness = [signature, Buffer.from(lnPreimage, 'hex'), redeemBuf];
  tx.setWitness(0, witness);

  logger.info('claimTransaction:', tx.toHex());

  bitcoinRpc.call('sendrawtransaction', [tx.toHex()], (err) => {
    if (err) {
      logger.error(`sendrawtransaction(): ${err}`);
    } else {
      logger.info('claimTransaction: hash:', tx.getId());

      updateRedisOrderAndPublish(`${orderState.prefix}:${invoice}`, {
        state: orderState.WaitingForClaimingConfirmation,
        invoice,
        onchainNetwork: LNSWAP_CHAIN,
        claimingTxn: tx.getId(),
      }).catch(e => logger.error(`Error updateRedisOrderAndPublish: ${e}`));
    }
  });
}

bitcoinRpc.init(rpcHost, parseInt(rpcPort, DEC_BASE), rpcUsername, rpcPassword);

zmqRawTxSocket.on('message', (topic, message) => {
  if (topic.toString() !== 'rawtx') return;

  const txn = bitcoin.Transaction.fromHex(message.toString('hex'));
  const outputAddresses = getAddressesFromOuts(txn.outs);

  outputAddresses.forEach(({ address, tokens, index }) => {
    const addrInfo = interestedAddrs.get(address);
    if (addrInfo && parseFloat(addrInfo.reqTokens, DEC_BASE) === parseFloat(tokens) / 100000000) {
      logger.info(`found funding outpoint ${txn.getId()}:${index} for addr ${address} for invoice ${addrInfo.invoice}`);

      updateRedisOrderAndPublish(`${orderState.prefix}:${addrInfo.invoice}`, {
        state: orderState.WaitingForFundingConfirmation,
        invoice: addrInfo.invoice,
        onchainNetwork: LNSWAP_CHAIN,
        fundingTxn: txn.getId(),
        fundingTxnIndex: index,
      }).catch(e => logger.error(`Error updateRedisOrderAndPublish: ${e}`));

      interestedAddrs.delete(address);
    }
  });
});

zmqRawBlockSocket.on('message', (topic, message) => {
  if (topic.toString() !== 'rawblock') return;
  const blk = bitcoin.Block.fromHex(message.toString('hex'));
  const txns = blk.transactions;
  txns.forEach((txn) => {
    const invoice = interestedTxns.get(txn.getId());
    if (invoice) {
      logger.info(`orderFunded ${txn.getId()} for invoice ${invoice}`);
      updateRedisOrderAndPublish(`${orderState.prefix}:${invoice}`, {
        state: orderState.OrderFunded,
        invoice,
        onchainNetwork: LNSWAP_CHAIN,
        fundingTxn: txn.getId(),
        fundingBlockHash: blk.getId(),
      }).catch(e => logger.error(`Error updateRedisOrderAndPublish: ${e}`));

      interestedTxns.delete(txn.getId());
    }
  });
});

zmqRawBlockSocket.connect(LNSWAP_CHAIN_ZMQ_RAWBLOCK_URL);
zmqRawBlockSocket.subscribe('rawblock');

zmqRawTxSocket.connect(LNSWAP_CHAIN_ZMQ_RAWTX_URL);
zmqRawTxSocket.subscribe('rawtx');

redisSub.on('message', (channel, msg) => {
  logger.debug(`[message]${channel}: ${msg}`);
  if (channel !== orderState.channel) return;

  try {
    const {
      state, invoice, onchainNetwork, onchainAmount, fundingTxn, lnPreimage, swapAddress,
    } = orderState.decodeMessage(msg);
    // only handle orders belong to this chain
    if (onchainNetwork !== LNSWAP_CHAIN) return;

    switch (state) {
      case orderState.WaitingForFunding:
        interestedAddrs.set(swapAddress, { reqTokens: onchainAmount, invoice });
        logger.info(`added interestedAddr: ${swapAddress}, onchainAmount: ${onchainAmount}, invoice: ${invoice}`);
        break;

      case orderState.WaitingForFundingConfirmation:
        interestedTxns.set(fundingTxn, invoice);
        logger.info('added interestedTxn: ', fundingTxn);
        break;

      case orderState.WaitingForClaiming:
        redisClient.hmget(`${orderState.prefix}:${invoice}`, 'fundingTxn', 'fundingTxnIndex', 'swapKeyIndex', 'redeemScript', 'onchainAmount', (err, reply) => {
          if (!reply || reply.includes(null)) {
            logger.error('error getting order:', invoice);
            return;
          }
          const [fundingTxnClaim, fundingTxnIndex, swapKeyIndex, redeemScript,
            onchainAmountClaim] = reply;
          claimTransaction({
            invoice,
            onchainAmount: onchainAmountClaim,
            lnPreimage,
            fundingTxn: fundingTxnClaim,
            fundingTxnIndex,
            swapKeyIndex,
            redeemScript,
          });
        });
        break;

      default:
        break;
    }
  } catch (e) {
    logger.error(e);
  }
});

redisSub.on('subscribe', (channel, count) => {
  logger.info(`[subcribe]channel: ${channel}, count: ${count}`);
});

redisSub.subscribe(orderState.channel);

// Blockchain Height format used by swap service: '1254834'
setInterval(() => {
  bitcoinRpc.call('getblockcount', [], (err, res) => {
    if (err) {
      logger.error(`getblockcount(): ${err}`);
    } else {
      currentBlockHeight = res.result;
      redisClient.set(`Blockchain:${LNSWAP_CHAIN}:Height`, res.result, 'EX', BLOCK_HEIGHT_EXPIRATION);
    }
  });
}, BLOCK_HEIGHT_INTERVAL);

// Blockchain Fee Estimation JSON format used by swap service:
// {
//   feerate: '0.00001',
//   blocks:  '1'
// }
setInterval(() => {
  bitcoinRpc.call('estimatesmartfee', [1], (err, res) => {
    if (err) {
      logger.error(`estimatesmartfee(): ${err}`);
    } else {
      const fee = JSON.stringify(res.result);
      redisClient.set(`Blockchain:${LNSWAP_CHAIN}:FeeEstimation`, fee, 'EX', FEE_ESTIMATION_EXPIRATION);
    }
  });
}, FEE_ESTIMATION_INTERVAL);

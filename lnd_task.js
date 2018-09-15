const { getRoutes, payInvoice } = require('ln-service');
const log4js = require('log4js');
const { redisClient, redisSub, updateRedisOrderAndPublish } = require('./service/redis_client.js');
const { lnd } = require('./service/lnd.js');
const orderState = require('./service/order_state.js');

const logger = log4js.getLogger();
logger.level = 'all';

redisSub.on('subscribe', (channel, count) => {
  logger.info(`[subcribe]channel: ${channel}, count: ${count}`);
});

redisSub.on('message', (channel, msg) => {
  logger.debug(`[message]${channel}: ${msg}`);
  if (channel !== orderState.channel) return;

  const {
    state, invoice, onchainNetwork, lnDestPubKey, lnAmount,
  } = orderState.decodeMessage(msg);

  if (state === orderState.Init) {
    getRoutes({ destination: lnDestPubKey, lnd, tokens: lnAmount }, (err, routes) => {
      if (err) {
        logger.error(`getRoutes to ${lnDestPubKey}, amount: ${lnAmount}, invoice: ${invoice}, err: ${err}`);
      } else {
        // do NOT pubulish any message
        redisClient.hset(`${orderState.prefix}:${invoice}`, 'lnRoutes', JSON.stringify(routes));
        logger.info(`getRoutes to ${lnDestPubKey}, routes: ${JSON.stringify(routes)}`);
      }
    });
  } else if (state === orderState.OrderFunded) {
    // TODO: set lnPaymentLock and state before pay
    payInvoice({ lnd, invoice }, (err, payResult) => {
      const refundReason = 'Lightning payment failed.';
      const newState = err ? orderState.WaitingForRefund : orderState.WaitingForClaiming;
      const lnPreimage = payResult ? payResult.payment_secret : '';

      if (err) logger.error(`payInvoice ${invoice} failed: ${err}`);
      updateRedisOrderAndPublish(`${orderState.prefix}:${invoice}`, {
        state: newState,
        invoice,
        onchainNetwork,
        refundReason,
        lnPreimage,
      }).then(() => logger.info(`payInvoice: ${invoice}, preimage: ${lnPreimage}`))
        .catch(e => logger.error(`Error updateRedisOrderAndPublish after payInvoice: ${e}`));
    });
  }
});

redisSub.subscribe(orderState.channel);

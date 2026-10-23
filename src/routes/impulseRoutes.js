'use strict';

const {
  evaluateImpulsePurchase,
  fastForwardAllCoolingItems,
  resolveCooldownItem
} = require('../services/impulseService');
const { buildDashboardState } = require('./dashboardRoutes');

async function handleImpulseRoutes(db, method, pathname, body) {
  if (method === 'POST' && pathname === '/api/impulse/evaluate') {
    const evaluation = await evaluateImpulsePurchase(db, body);
    return {
      status: 200,
      data: {
        ok: true,
        evaluation,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  if (method === 'POST' && (pathname === '/api/cooldown/resolve')) {
    const res = await resolveCooldownItem(db, body.itemId, body.decision);
    return {
      status: 200,
      data: {
        ok: true,
        ...res,
        dashboard: await buildDashboardState(db)
      }
    };
  }

  // 收納於設定頁「開發者測試區」之 72h 快轉功能
  if (method === 'POST' && (pathname === '/api/dev/fast-forward-cooldown' || pathname === '/api/cooldown/fast-forward')) {
    await fastForwardAllCoolingItems(db, body.itemId || null);
    return {
      status: 200,
      data: {
        ok: true,
        message: '⏩ 已快轉冷卻池商品滿 72 小時（開發測試用）',
        dashboard: await buildDashboardState(db)
      }
    };
  }

  return null;
}

module.exports = {
  handleImpulseRoutes
};

'use strict';

const {
  THIRD_PARTY_PREFIXES,
  MERCHANT_ALIASES,
  TANK_TRANSFER_RULES,
  CATEGORY_RULES
} = require('../config/merchantRules');

/**
 * 全形字元轉半形字元
 */
function toHalfWidth(str) {
  return String(str || '')
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 商店名稱正規化：讀取 config/merchantRules.js 剔除第三方支付前綴並標準化同義店名
 */
function normalizeMerchant(rawMerchant) {
  let s = toHalfWidth(rawMerchant || '').trim().toUpperCase();
  if (!s) return '未知項目';

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of THIRD_PARTY_PREFIXES) {
      const reg = new RegExp(`^${escapeRegex(prefix.toUpperCase())}[\\*\\-\\s_:：]*`, 'i');
      if (reg.test(s)) {
        s = s.replace(reg, '').trim();
        changed = true;
      }
    }
  }

  for (const rule of MERCHANT_ALIASES) {
    if (rule.pattern.test(s)) {
      return rule.normalized;
    }
  }

  s = s.replace(/\s+(股份有限公司|有限公司)$/g, '').trim();
  return s || '未知項目';
}

/**
 * 推斷消費分類與是否觸發實體水庫連動 (如悠遊卡自動加值、ATM提款)
 */
function classifyMerchantAndFlow(rawMerchant, normalizedMerchant, contextText = '') {
  const combined = `${rawMerchant || ''} ${normalizedMerchant || ''} ${contextText || ''}`;

  for (const tankRule of TANK_TRANSFER_RULES) {
    if (tankRule.pattern.test(combined)) {
      return {
        category: tankRule.category,
        autoTankTransferType: tankRule.tankType // 'EASYCARD' | 'CASH'
      };
    }
  }

  for (const catRule of CATEGORY_RULES) {
    if (catRule.pattern.test(combined)) {
      return {
        category: catRule.category,
        autoTankTransferType: null
      };
    }
  }

  return {
    category: '一般消費',
    autoTankTransferType: null
  };
}

module.exports = {
  toHalfWidth,
  normalizeMerchant,
  classifyMerchantAndFlow
};

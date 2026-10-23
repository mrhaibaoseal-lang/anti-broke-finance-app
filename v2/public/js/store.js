/**
 * 前端輕量單向資料流 Store
 */
const store = {
  dashboard: null,
  activeTab: 'home',
  recordFilter: 'ALL',
  ocrDirection: 'OUT',
  ocrFlowType: 'EXPENSE',
  impulseItemType: 'WANT',
  listeners: new Set()
};

export function getStore() {
  return store;
}

export function setDashboardState(newDashboard) {
  store.dashboard = newDashboard;
  for (const fn of store.listeners) {
    try {
      fn(store.dashboard);
    } catch (err) {
      console.error('[Store Render Error]', err);
    }
  }
}

export function subscribeDashboard(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

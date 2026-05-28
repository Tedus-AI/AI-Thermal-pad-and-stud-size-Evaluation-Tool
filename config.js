// Database mode: 'local' | 'sharepoint'
const DB_MODE = 'sharepoint';

const SHAREPOINT_CONFIG = {
  clientId: '17fc1ab4-0ab0-4520-9315-6faa86d9e8ec',
  tenantId: '19f25823-17ff-421f-ad4e-8fed035aedda',
  authority: 'https://login.microsoftonline.com/19f25823-17ff-421f-ad4e-8fed035aedda',
  redirectUri: 'https://tedus-ai.github.io/AI-Thermal-pad-and-stud-size-Evaluation-Tool/',
  scopes: ['Files.ReadWrite.All', 'Sites.Read.All', 'Sites.ReadWrite.All'],
  siteHostname: 'deltao365.sharepoint.com',
  sitePath: '/sites/Thermal-Spec-DB',
  filePath: '/ToolDatabase/thermal_db.json',
  lockTimeoutMinutes: 60
};

window.DB_MODE = DB_MODE;
window.SHAREPOINT_CONFIG = SHAREPOINT_CONFIG;

/* ── Feature Flags（Phase 2+ dual-write 控制）─────────────────────
 * 預設全 false / 'json'，行為與改動前完全一致。
 * 切換方式：在 browser console 輸入：
 *   window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK = true
 * 回退方式：
 *   window.FEATURE_FLAGS.DUAL_WRITE_FEEDBACK = false
 */
window.FEATURE_FLAGS = {
  DUAL_WRITE_FEEDBACK:   true,   // 寫 feedback_items 時同步 shadow-write 到 List
  SHOW_DEV_PANEL:        true,  // 顯示開發者驗證區（維護者用）
  PRIMARY_FEEDBACK:      'json', // 'json' | 'list'，控制 feedback 讀取來源（Phase 4+）
  SHADOW_READ_FEEDBACK:  false,  // 讀 feedback 時背景 shadow-read List 做 diff（Phase 3+）
};

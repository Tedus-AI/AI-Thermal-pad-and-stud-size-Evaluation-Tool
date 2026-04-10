// Database mode: 'local' | 'sharepoint'
const DB_MODE = 'sharepoint';

const SHAREPOINT_CONFIG = {
  clientId: '17fc1ab4-0ab0-4520-9315-6faa86d9e8ec',
  tenantId: '19f25823-17ff-421f-ad4e-8fed035aedda',
  authority: 'https://login.microsoftonline.com/19f25823-17ff-421f-ad4e-8fed035aedda',
  redirectUri: 'https://tedus-ai.github.io/AI-Thermal-pad-and-stud-size-Evaluation-Tool/',
  scopes: ['Files.ReadWrite', 'Sites.Read.All'],
  siteHostname: 'deltaww.sharepoint.com',
  sitePath: '/sites/Thermal-Spec-DB',
  filePath: '/ToolDatabase/thermal_db.json',
  lockTimeoutMinutes: 10
};

window.DB_MODE = DB_MODE;
window.SHAREPOINT_CONFIG = SHAREPOINT_CONFIG;

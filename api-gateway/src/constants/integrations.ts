/** Allowed integration provider IDs — keep in sync with frontend integrationCatalog.ts */
export const INTEGRATION_PROVIDER_IDS = [
    'shared_folder_sftp',
    'sharepoint',
    'onedrive',
    'google_drive',
    'box',
    'email_inbox',
    'sap',
    'netsuite',
    'dynamics365',
    'odoo',
    'erpnext',
    'quickbooks',
    'ignition',
    'siemens_opcenter',
    'factorytalk',
    'aveva',
    'tulip',
    'mastercontrol',
    'etq_reliance',
    'ibm_maximo',
    'fiix_upkeep',
    'custom_webhook',
    'sql_csv_drop',
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDER_IDS)[number];

export const SECRET_FIELD_KEYS = new Set([
    'password',
    'clientSecret',
    'privateKey',
    'apiKey',
    'apiSecret',
    'consumerSecret',
    'tokenSecret',
    'refreshToken',
    'connectionString',
]);

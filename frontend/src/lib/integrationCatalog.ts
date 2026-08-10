export type IntegrationCategory =
    | "file_cloud"
    | "erp"
    | "mes"
    | "quality"
    | "maintenance"
    | "generic";

export type IntegrationDirection = "inbound" | "outbound" | "both";

export type IntegrationFieldType = "text" | "password" | "url" | "number" | "select";

export type IntegrationField = {
    key: string;
    label: string;
    type: IntegrationFieldType;
    required?: boolean;
    placeholder?: string;
    secret?: boolean;
    options?: Array<{ value: string; label: string }>;
    help?: string;
};

export type IntegrationCatalogItem = {
    id: string;
    name: string;
    category: IntegrationCategory;
    description: string;
    directions: IntegrationDirection;
    fields: IntegrationField[];
    guideSteps: string[];
    setupNotes: string;
};

export const INTEGRATION_CATEGORIES: Array<{ id: IntegrationCategory | "all"; label: string }> = [
    { id: "all", label: "All" },
    { id: "file_cloud", label: "File & Cloud" },
    { id: "erp", label: "ERP" },
    { id: "mes", label: "MES / Shop Floor" },
    { id: "quality", label: "Quality / QMS" },
    { id: "maintenance", label: "Maintenance" },
    { id: "generic", label: "Generic" },
];

const SCHEDULE_FIELD: IntegrationField = {
    key: "intervalMinutes",
    label: "Sync interval (minutes)",
    type: "number",
    required: true,
    placeholder: "15",
    help: "How often Visibility Docs should pull new files when auto-sync is enabled.",
};

const AGENT_FIELD: IntegrationField = {
    key: "phase3Agent",
    label: "Default AI agent",
    type: "select",
    options: [
        { value: "", label: "Auto-detect" },
        { value: "finance_agent", label: "Finance" },
        { value: "hr_agent", label: "HR" },
        { value: "legal_agent", label: "Legal" },
        { value: "procurement_agent", label: "Procurement" },
        { value: "compliance_agent", label: "Compliance" },
        { value: "other_agent", label: "Other" },
    ],
};

const OUTBOUND_FIELD: IntegrationField = {
    key: "outboundWebhookUrl",
    label: "Outbound results webhook URL",
    type: "url",
    placeholder: "https://factory.example.com/hooks/visibility-results",
    help: "Optional. Manual Send can POST file / summary / extracted JSON here. Not auto — only when you click Send.",
};

const COMMON_TAIL: IntegrationField[] = [SCHEDULE_FIELD, AGENT_FIELD, OUTBOUND_FIELD];

function guide(software: string, whereKeys: string, mapHint: string, verifyHint: string): string[] {
    return [
        whereKeys,
        `Paste the required credentials and connection details into the Connect form on this page.`,
        `Set sync interval (suggested: every 15 minutes for production docs, or end-of-shift for batch reports).`,
        mapHint,
        `Optionally add an Outbound results webhook URL so AI summaries, extracted fields, and status can be sent back to ${software} or your middleware.`,
        `Click Save connection, then Test connection to validate required fields.`,
        verifyHint,
        `After go-live, monitor last sync status on this card and check Activity for ingest events.`,
    ];
}

const outboundNote = (system: string) =>
    `Bidirectional: inbound pulls documents into Visibility Docs; outbound can POST JSON summaries (documentId, filename, status, extracted fields, AI summary) to your webhook so ${system} or middleware can update tickets, quality records, or dashboards.`;

/**
 * Curated catalog — only high-value factory / enterprise connectors.
 * Live today: google_drive (sync), custom_webhook (ingest). Others are setup + guides for rollout.
 */
export const INTEGRATION_CATALOG: IntegrationCatalogItem[] = [
    // —— File & Cloud ——
    {
        id: "google_drive",
        name: "Google Drive",
        category: "file_cloud",
        description: "Pull files from a shared Google Drive folder — manual check or auto sync on interval/daily.",
        directions: "both",
        fields: [
            { key: "serviceAccountEmail", label: "Service account email", type: "text", required: true },
            {
                key: "privateKey",
                label: "Service account private key (JSON or PEM)",
                type: "password",
                required: true,
                secret: true,
            },
            {
                key: "folderId",
                label: "Folder ID or Drive URL",
                type: "text",
                required: true,
                placeholder: "1AbC… or https://drive.google.com/drive/folders/…",
                help: "Paste the folder ID or the full sharing link. Share that folder with the service-account email as Editor (needed for Send uploads).",
            },
            {
                key: "syncMode",
                label: "Sync mode",
                type: "select",
                required: true,
                options: [
                    { value: "interval", label: "Every N minutes — ask before upload (or enable auto)" },
                    { value: "daily", label: "Once daily — auto upload in background" },
                    { value: "manual", label: "Manual only — click to sync" },
                ],
                help: "Daily uploads in the backend even if you are offline. Interval finds files then asks you (unless auto-upload is on).",
            },
            {
                key: "intervalMinutes",
                label: "Interval (minutes)",
                type: "number",
                placeholder: "15",
                help: "Used when sync mode is “every N minutes”. Min 5, max 1440.",
            },
            {
                key: "dailyAt",
                label: "Daily time (HH:MM)",
                type: "text",
                placeholder: "09:00",
                help: "Used when sync mode is “once daily”. Server local time. Failures show as a notification when you log in.",
            },
            {
                key: "intervalAutoUpload",
                label: "Interval auto-upload (skip confirm)",
                type: "select",
                options: [
                    { value: "false", label: "No — show confirm dialog each interval" },
                    { value: "true", label: "Yes — upload automatically each interval" },
                ],
                help: "Only for interval mode. You can also turn this on from the confirm dialog.",
            },
            {
                key: "autoSyncEnabled",
                label: "Auto sync enabled",
                type: "select",
                options: [
                    { value: "true", label: "Yes — run on schedule" },
                    { value: "false", label: "No — pause auto sync" },
                ],
            },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "In Google Cloud Console create a service account, enable Drive API, download the JSON key, and share the Drive folder with the service account email as Editor (required for Send uploads).",
            "Paste folderId from the Drive URL, choose sync mode (interval / daily / manual), and pick the default AI agent.",
            "Optionally set Outbound webhook URL — Send is always manual (document details or Status → Send from library).",
            "After connect: Status → Check Drive files to import. Use Send to push original / AI summary / extracted JSON into the same linked Drive folder and/or your webhook.",
        ],
        setupNotes: outboundNote("Apps Script / Cloud Function"),
    },
    {
        id: "sharepoint",
        name: "SharePoint",
        category: "file_cloud",
        description: "Sync document libraries from Microsoft SharePoint Online or Server.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            {
                key: "siteUrl",
                label: "Site URL",
                type: "url",
                required: true,
                placeholder: "https://contoso.sharepoint.com/sites/Quality",
            },
            {
                key: "libraryPath",
                label: "Document library / folder",
                type: "text",
                required: true,
                placeholder: "Shared Documents/Incoming",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "SharePoint",
            "In Azure Portal → App registrations, create an app, grant Sites.Read.All (and Sites.ReadWrite.All if pushing results), then create a client secret.",
            "Point libraryPath at the folder that receives factory exports; choose the matching AI agent.",
            "Upload a test file to that SharePoint folder and confirm it lands in Documents after the next sync window."
        ),
        setupNotes: outboundNote("SharePoint (via Graph webhook/middleware)"),
    },
    {
        id: "onedrive",
        name: "OneDrive",
        category: "file_cloud",
        description: "Connect a OneDrive for Business folder used by plant admins.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            {
                key: "drivePath",
                label: "Folder path",
                type: "text",
                required: true,
                placeholder: "/Visibility/Inbox",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "OneDrive",
            "Register an Azure AD app with Files.Read.All (and Files.ReadWrite.All for outbound), generate a client secret.",
            "Set drivePath to the inbox folder used by your team.",
            "Place a sample file in OneDrive and verify it appears in Documents."
        ),
        setupNotes: outboundNote("OneDrive / Power Automate"),
    },
    {
        id: "shared_folder_sftp",
        name: "Shared Folder / SFTP",
        category: "file_cloud",
        description: "Watch a network share or SFTP folder for PDFs, Excel, images, and drop them into Documents.",
        directions: "both",
        fields: [
            { key: "host", label: "Host / server", type: "text", required: true, placeholder: "files.factory.local" },
            { key: "port", label: "Port", type: "number", placeholder: "22" },
            { key: "username", label: "Username", type: "text", required: true },
            {
                key: "password",
                label: "Password / private key passphrase",
                type: "password",
                required: true,
                secret: true,
            },
            {
                key: "remotePath",
                label: "Remote folder path",
                type: "text",
                required: true,
                placeholder: "/QC/Reports",
            },
            {
                key: "protocol",
                label: "Protocol",
                type: "select",
                required: true,
                options: [
                    { value: "sftp", label: "SFTP" },
                    { value: "smb", label: "SMB / Windows share" },
                    { value: "ftp", label: "FTP" },
                ],
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Shared Folder / SFTP",
            "Ask IT for SFTP or SMB access to the folder where factory software exports reports (e.g. \\\\server\\QC\\Reports or /exports/daily).",
            "Map the folder to a default AI agent (Compliance for QC, Finance for invoices).",
            "Drop a sample PDF into the folder (or wait for the next export), then confirm it appears under Documents with source Shared Folder."
        ),
        setupNotes: outboundNote("your factory middleware"),
    },
    {
        id: "email_inbox",
        name: "Email Inbox",
        category: "file_cloud",
        description: "Ingest email attachments (invoices, QC reports) from a dedicated mailbox.",
        directions: "both",
        fields: [
            {
                key: "imapHost",
                label: "IMAP host",
                type: "text",
                required: true,
                placeholder: "outlook.office365.com",
            },
            { key: "imapPort", label: "IMAP port", type: "number", placeholder: "993" },
            { key: "username", label: "Mailbox address", type: "text", required: true },
            {
                key: "password",
                label: "App password / IMAP password",
                type: "password",
                required: true,
                secret: true,
            },
            { key: "folder", label: "Folder", type: "text", placeholder: "INBOX" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Email Inbox",
            "Create a dedicated mailbox (e.g. docs-ingest@factory.com) and enable IMAP / app password (OAuth recommended for M365).",
            "Forward or CC vendor/plant emails that carry PDF/Excel attachments to this mailbox.",
            "Send yourself a test email with a PDF attachment and confirm it appears in Documents."
        ),
        setupNotes: outboundNote("reply email or SMTP notification"),
    },

    // —— ERP ——
    {
        id: "dynamics365",
        name: "Microsoft Dynamics 365",
        category: "erp",
        description: "Finance & Supply Chain or Business Central document sync via Dataverse / BC APIs.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            { key: "environmentUrl", label: "Environment URL", type: "url", required: true },
            {
                key: "entityPath",
                label: "Entity / company path",
                type: "text",
                placeholder: "companies(...)/purchaseInvoices",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Dynamics 365",
            "Register an Azure AD app, grant Dynamics/Business Central API permissions, and create a client secret.",
            "Enter environmentUrl and the entity path for attachments or document exports.",
            "Export one purchase invoice PDF and verify ingest."
        ),
        setupNotes: outboundNote("Dataverse / Power Automate"),
    },
    {
        id: "sap",
        name: "SAP (S/4HANA / Business One)",
        category: "erp",
        description: "Connect SAP exports or OData / B1 Service Layer for invoices, POs, and quality docs.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "SAP API / Service Layer base URL", type: "url", required: true },
            { key: "companyDb", label: "Company DB / Client", type: "text", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "password", label: "Password", type: "password", required: true, secret: true },
            {
                key: "exportPath",
                label: "Export path or OData entity",
                type: "text",
                placeholder: "Attachments2 or /export/pdf",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "SAP",
            "Work with your SAP Basis/IT team to enable Service Layer (B1) or OData APIs (S/4). Create a technical user with read access to attachments/exports.",
            "Prefer scheduled PDF/CSV export to a folder if API access is restricted — then also configure Shared Folder. Otherwise paste Service Layer URL and credentials here.",
            "Trigger a sample invoice/PO attachment export and verify the file in Documents with Finance or Procurement agent."
        ),
        setupNotes: outboundNote("SAP (via middleware / CPI / RFC wrapper)"),
    },
    {
        id: "odoo",
        name: "Odoo",
        category: "erp",
        description: "Odoo XML-RPC / JSON-RPC for attachments from Accounting, Inventory, and Quality apps.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Odoo base URL", type: "url", required: true },
            { key: "database", label: "Database name", type: "text", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "apiKey", label: "API key / password", type: "password", required: true, secret: true },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Odoo",
            "In Odoo → Preferences / Users, enable API keys for a technical user with access to Attachments (ir.attachment).",
            "Paste base URL, database, and API key; map agent (Finance for invoices, Compliance for QC).",
            "Attach a sample PDF to an Odoo record and confirm Documents."
        ),
        setupNotes: outboundNote("Odoo webhook / automated action"),
    },

    // —— MES ——
    {
        id: "ignition",
        name: "Ignition (Inductive Automation)",
        category: "mes",
        description: "MES/SCADA reports and PDF exports from Ignition Perspective / Reporting module.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Ignition Gateway URL", type: "url", required: true },
            { key: "username", label: "API username", type: "text", required: true },
            { key: "password", label: "Password", type: "password", required: true, secret: true },
            {
                key: "reportPath",
                label: "Report / tag path",
                type: "text",
                placeholder: "Reports/ShiftSummary",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Ignition",
            "Enable WebDev or Reporting HTTP endpoints; create a gateway user for report download. Or schedule Ignition to write PDFs to a shared folder and use Shared Folder + this card for metadata.",
            "Enter Gateway URL and report path; map Compliance/Other agent as needed.",
            "Generate a shift report PDF and verify Documents."
        ),
        setupNotes: outboundNote("Ignition WebDev / MQTT bridge"),
    },

    // —— Quality ——
    {
        id: "mastercontrol",
        name: "MasterControl",
        category: "quality",
        description: "QMS controlled documents, CAPA, and training records.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "MasterControl URL", type: "url", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            {
                key: "password",
                label: "Password / API token",
                type: "password",
                required: true,
                secret: true,
            },
            { key: "vaultPath", label: "Vault / collection", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "MasterControl",
            "Request API or export credentials from your QMS admin for the vault that holds SOPs and audit packs.",
            "Set Compliance as the default AI agent.",
            "Publish/export one controlled document and verify Documents."
        ),
        setupNotes: outboundNote("MasterControl workflow hooks"),
    },

    // —— Maintenance ——
    {
        id: "fiix_upkeep",
        name: "Fiix / UpKeep",
        category: "maintenance",
        description: "CMMS work-order photos and PDF checklists.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "API base URL", type: "url", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
            {
                key: "provider",
                label: "CMMS product",
                type: "select",
                required: true,
                options: [
                    { value: "fiix", label: "Fiix" },
                    { value: "upkeep", label: "UpKeep" },
                ],
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Fiix / UpKeep",
            "In CMMS settings generate an API key with attachment read permissions.",
            "Select Fiix or UpKeep and set sync interval for closed work orders.",
            "Close a work order with an attachment and verify Documents."
        ),
        setupNotes: outboundNote("CMMS webhook / Zapier"),
    },

    // —— Generic (always useful) ——
    {
        id: "custom_webhook",
        name: "Custom Webhook / REST API",
        category: "generic",
        description: "Universal inbound HTTP endpoint — any factory system can POST files now. Best starting point.",
        directions: "both",
        fields: [
            {
                key: "label",
                label: "Connection label",
                type: "text",
                required: true,
                placeholder: "Plant A line 2",
            },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "Enter a label (e.g. Plant A middleware) and optional default AI agent, then click Save connection.",
            "Copy the Ingest URL and Integration API Key shown after connect.",
            "From your factory software or middleware, POST multipart/form-data with field name file to the Ingest URL.",
            "Include header X-Integration-Key: <your key>. Optional form fields: phase3Agent, filename.",
            'Example (curl): curl -X POST "$INGEST_URL" -H "X-Integration-Key: $KEY" -F "file=@report.pdf" -F "phase3Agent=compliance_agent"',
            "Optional outbound: set Outbound results webhook URL to receive AI summaries after processing.",
            "Confirm the uploaded file appears under Documents with metadata.source = custom_webhook.",
            "Rotate the key anytime from Status / rotate key.",
        ],
        setupNotes:
            "Live today: inbound file ingest via the API key and URL below. Outbound: set Outbound results webhook URL, then use Send from library (Status tab or document details) to POST summaries and extracted JSON to your endpoint.",
    },
    {
        id: "sql_csv_drop",
        name: "SQL Export / CSV Drop",
        category: "generic",
        description: "Scheduled DB export or CSV/Excel drop from legacy factory databases.",
        directions: "both",
        fields: [
            {
                key: "connectionString",
                label: "Read-only DB connection string (optional)",
                type: "password",
                secret: true,
            },
            {
                key: "queryOrView",
                label: "SQL view / query name",
                type: "text",
                placeholder: "dbo.v_daily_qc_export",
            },
            {
                key: "dropFolder",
                label: "CSV/Excel drop folder path",
                type: "text",
                placeholder: "\\\\server\\exports\\csv",
            },
            {
                key: "filePattern",
                label: "File name pattern",
                type: "text",
                placeholder: "qc_*.csv",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "SQL Export / CSV Drop",
            "Prefer a read-only DB user or a nightly job that writes CSV/Excel into a drop folder (safer than live SQL from the app).",
            "Fill either connectionString + queryOrView, or dropFolder + filePattern (or both).",
            "Run the export job once and verify the CSV/Excel appears in Documents for AI analysis."
        ),
        setupNotes: outboundNote("your ETL / SSIS package"),
    },
];

export function getIntegrationById(id: string): IntegrationCatalogItem | undefined {
    return INTEGRATION_CATALOG.find((i) => i.id === id);
}

export function catalogProviderIds(): string[] {
    return INTEGRATION_CATALOG.map((i) => i.id);
}

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
    // HIDDEN FOR NOW — uncomment when more integrations are shown again:
    // { id: "mes", label: "MES / Shop Floor" },
    // { id: "quality", label: "Quality / QMS" },
    // { id: "maintenance", label: "Maintenance" },
    // { id: "generic", label: "Generic" },
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
    help: "Optional. Visibility Docs can POST AI summaries / status JSON here after processing.",
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

/** Currently visible integrations. Uncomment items below to show more on the page. */
export const INTEGRATION_CATALOG: IntegrationCatalogItem[] = [
    {
        id: "google_drive",
        name: "Google Drive",
        category: "file_cloud",
        description: "Pull files from a shared Google Drive folder.",
        directions: "both",
        fields: [
            { key: "serviceAccountEmail", label: "Service account email", type: "text", required: true },
            { key: "privateKey", label: "Service account private key (JSON or PEM)", type: "password", required: true, secret: true },
            { key: "folderId", label: "Folder ID", type: "text", required: true },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Google Drive",
            "In Google Cloud Console create a service account, enable Drive API, download the JSON key, and share the Drive folder with the service account email.",
            "Paste folderId from the Drive URL and pick the default AI agent.",
            "Add a test file to the shared folder and confirm ingest in Documents."
        ),
        setupNotes: outboundNote("Apps Script / Cloud Function"),
    },
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
            { key: "entityPath", label: "Entity / company path", type: "text", placeholder: "companies(...)/purchaseInvoices" },
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

    // =====================================================================
    // HIDDEN FOR NOW — uncomment any block below (and add a comma after
    // Dynamics 365 if needed) when you want that integration to show again.
    // =====================================================================

    /*
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
            { key: "password", label: "Password / private key passphrase", type: "password", required: true, secret: true },
            { key: "remotePath", label: "Remote folder path", type: "text", required: true, placeholder: "/QC/Reports" },
            { key: "protocol", label: "Protocol", type: "select", required: true, options: [
                { value: "sftp", label: "SFTP" },
                { value: "smb", label: "SMB / Windows share" },
                { value: "ftp", label: "FTP" },
            ]},
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
        id: "sharepoint",
        name: "SharePoint",
        category: "file_cloud",
        description: "Sync document libraries from Microsoft SharePoint Online or Server.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            { key: "siteUrl", label: "Site URL", type: "url", required: true, placeholder: "https://contoso.sharepoint.com/sites/Quality" },
            { key: "libraryPath", label: "Document library / folder", type: "text", required: true, placeholder: "Shared Documents/Incoming" },
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
            { key: "drivePath", label: "Folder path", type: "text", required: true, placeholder: "/Visibility/Inbox" },
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
        id: "box",
        name: "Box",
        category: "file_cloud",
        description: "Enterprise Box folders for controlled document exchange.",
        directions: "both",
        fields: [
            { key: "clientId", label: "Box Client ID", type: "text", required: true },
            { key: "clientSecret", label: "Box Client Secret", type: "password", required: true, secret: true },
            { key: "enterpriseId", label: "Enterprise ID", type: "text", required: true },
            { key: "folderId", label: "Folder ID", type: "text", required: true },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Box",
            "Create a Box Custom App (JWT or OAuth), approve it in Admin Console, and note Client ID/Secret and Enterprise ID.",
            "Grant the app access to the inbox folder; set folderId and agent mapping.",
            "Upload a sample file to Box and verify Documents."
        ),
        setupNotes: outboundNote("Box Skills / webhook"),
    },
    {
        id: "email_inbox",
        name: "Email Inbox",
        category: "file_cloud",
        description: "Ingest email attachments (invoices, QC reports) from a dedicated mailbox.",
        directions: "both",
        fields: [
            { key: "imapHost", label: "IMAP host", type: "text", required: true, placeholder: "outlook.office365.com" },
            { key: "imapPort", label: "IMAP port", type: "number", placeholder: "993" },
            { key: "username", label: "Mailbox address", type: "text", required: true },
            { key: "password", label: "App password / IMAP password", type: "password", required: true, secret: true },
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
            { key: "exportPath", label: "Export path or OData entity", type: "text", placeholder: "Attachments2 or /export/pdf" },
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
        id: "netsuite",
        name: "Oracle NetSuite",
        category: "erp",
        description: "Token-based NetSuite integration for transaction PDFs and saved searches.",
        directions: "both",
        fields: [
            { key: "accountId", label: "Account ID", type: "text", required: true },
            { key: "consumerKey", label: "Consumer Key", type: "text", required: true },
            { key: "consumerSecret", label: "Consumer Secret", type: "password", required: true, secret: true },
            { key: "tokenId", label: "Token ID", type: "text", required: true },
            { key: "tokenSecret", label: "Token Secret", type: "password", required: true, secret: true },
            { key: "savedSearchId", label: "Saved search / folder ID", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Oracle NetSuite",
            "Enable Token-Based Authentication, create an Integration record and Access Token for a role that can read File Cabinet / transactions.",
            "Paste TBA credentials and optional savedSearchId for the documents you want synced.",
            "Run a test fetch (or export one PDF) and confirm Documents."
        ),
        setupNotes: outboundNote("NetSuite RESTlet / SuiteScript"),
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
    {
        id: "erpnext",
        name: "ERPNext",
        category: "erp",
        description: "Frappe/ERPNext REST API for file attachments and print formats.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "ERPNext site URL", type: "url", required: true },
            { key: "apiKey", label: "API Key", type: "text", required: true },
            { key: "apiSecret", label: "API Secret", type: "password", required: true, secret: true },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "ERPNext",
            "User → API Access → Generate Keys for a system user with File / Print Format permissions.",
            "Paste site URL, API Key, and API Secret.",
            "Generate a sample PDF (Sales Invoice / Delivery Note) and verify Documents."
        ),
        setupNotes: outboundNote("ERPNext webhook"),
    },
    {
        id: "quickbooks",
        name: "QuickBooks",
        category: "erp",
        description: "QuickBooks Online invoices and attachments for finance document AI.",
        directions: "both",
        fields: [
            { key: "clientId", label: "Client ID", type: "text", required: true },
            { key: "clientSecret", label: "Client Secret", type: "password", required: true, secret: true },
            { key: "realmId", label: "Company (Realm) ID", type: "text", required: true },
            { key: "refreshToken", label: "Refresh token", type: "password", required: true, secret: true },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "QuickBooks",
            "Create an Intuit developer app, complete OAuth, and copy Client ID/Secret, Realm ID, and refresh token.",
            "Set Finance as the default AI agent.",
            "Create a test invoice PDF/attachment and confirm Documents."
        ),
        setupNotes: outboundNote("Intuit webhooks"),
    },
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
            { key: "reportPath", label: "Report / tag path", type: "text", placeholder: "Reports/ShiftSummary" },
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
    {
        id: "siemens_opcenter",
        name: "Siemens Opcenter",
        category: "mes",
        description: "MES quality and production documents from Siemens Opcenter / SIMATIC IT.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Opcenter API base URL", type: "url", required: true },
            { key: "clientId", label: "Client ID", type: "text", required: true },
            { key: "clientSecret", label: "Client Secret", type: "password", required: true, secret: true },
            { key: "plantCode", label: "Plant / site code", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Siemens Opcenter",
            "Obtain API credentials from your Siemens MES admin (OAuth client for Opcenter APIs).",
            "Configure plantCode and preferred export documents (batch records, COA).",
            "Export one batch record PDF and verify Documents."
        ),
        setupNotes: outboundNote("Opcenter event API / middleware"),
    },
    {
        id: "factorytalk",
        name: "Rockwell FactoryTalk",
        category: "mes",
        description: "FactoryTalk ProductionCentre / View SE report and recipe document sync.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "FactoryTalk services URL", type: "url", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "password", label: "Password", type: "password", required: true, secret: true },
            { key: "areaPath", label: "Area / line path", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Rockwell FactoryTalk",
            "Ask Rockwell admins for service account access to reporting endpoints or scheduled PDF drops.",
            "If only file export is available, pair this card with Shared Folder / SFTP using the same schedule.",
            "Produce a sample production report and verify Documents."
        ),
        setupNotes: outboundNote("FactoryTalk Transaction Manager / middleware"),
    },
    {
        id: "aveva",
        name: "AVEVA / Wonderware",
        category: "mes",
        description: "Historian and operations reports from AVEVA System Platform / Wonderware.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "AVEVA API / Insight URL", type: "url", required: true },
            { key: "apiKey", label: "API key / token", type: "password", required: true, secret: true },
            { key: "namespace", label: "Namespace / galaxy", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "AVEVA / Wonderware",
            "Enable Insight or REST connectors; create an API token with read access to report artifacts.",
            "Set namespace and sync interval aligned with shift reports.",
            "Export one operations PDF and verify Documents."
        ),
        setupNotes: outboundNote("AVEVA Insight webhook / Azure Function"),
    },
    {
        id: "tulip",
        name: "Tulip",
        category: "mes",
        description: "No-code MES tables and file connectors from Tulip apps.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Tulip instance URL", type: "url", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
            { key: "tableId", label: "Table / connector ID", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Tulip",
            "Account Settings → API Tokens; create a token with table/file read permissions.",
            "Map the table that stores document URLs or binary attachments.",
            "Complete a Tulip app step that attaches a file and verify Documents."
        ),
        setupNotes: outboundNote("Tulip Connector Function (HTTP)"),
    },
    {
        id: "mastercontrol",
        name: "MasterControl",
        category: "quality",
        description: "QMS controlled documents, CAPA, and training records.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "MasterControl URL", type: "url", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "password", label: "Password / API token", type: "password", required: true, secret: true },
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
    {
        id: "etq_reliance",
        name: "ETQ Reliance",
        category: "quality",
        description: "Quality events, audits, and document control from ETQ Reliance.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "ETQ base URL", type: "url", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
            { key: "module", label: "Module / form", type: "text", placeholder: "DocumentControl" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "ETQ Reliance",
            "Generate an API key in ETQ admin for Document Control / Audit modules.",
            "Set module name and Compliance agent.",
            "Release one document revision and verify Documents."
        ),
        setupNotes: outboundNote("ETQ REST callbacks"),
    },
    {
        id: "ibm_maximo",
        name: "IBM Maximo",
        category: "maintenance",
        description: "Work order attachments, manuals, and inspection docs from Maximo.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Maximo / MAS URL", type: "url", required: true },
            { key: "apiKey", label: "API key / API key token", type: "password", required: true, secret: true },
            { key: "orgId", label: "Maximo org / site", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "IBM Maximo",
            "Create an API key in Maximo Application Suite with read access to DocLinks / attached documents.",
            "Map to Compliance or Other agent for maintenance manuals.",
            "Attach a PDF to a work order and verify Documents."
        ),
        setupNotes: outboundNote("Maximo automation scripts / webhooks"),
    },
    {
        id: "fiix_upkeep",
        name: "Fiix / UpKeep",
        category: "maintenance",
        description: "CMMS work-order photos and PDF checklists.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "API base URL", type: "url", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
            { key: "provider", label: "CMMS product", type: "select", required: true, options: [
                { value: "fiix", label: "Fiix" },
                { value: "upkeep", label: "UpKeep" },
            ]},
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
    {
        id: "custom_webhook",
        name: "Custom Webhook / REST API",
        category: "generic",
        description: "Universal inbound HTTP endpoint — any factory system can POST files now. Best starting point.",
        directions: "both",
        fields: [
            { key: "label", label: "Connection label", type: "text", required: true, placeholder: "Plant A line 2" },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "Enter a label (e.g. Plant A middleware) and optional default AI agent, then click Save connection.",
            "Copy the Ingest URL and Integration API Key shown after connect.",
            "From your factory software or middleware, POST multipart/form-data with field name file to the Ingest URL.",
            "Include header X-Integration-Key: <your key>. Optional form fields: phase3Agent, filename.",
            "Example (curl): curl -X POST \"$INGEST_URL\" -H \"X-Integration-Key: $KEY\" -F \"file=@report.pdf\" -F \"phase3Agent=compliance_agent\"",
            "Optional outbound: set Outbound results webhook URL to receive AI summaries after processing.",
            "Confirm the uploaded file appears under Documents with metadata.source = custom_webhook.",
            "Rotate the key anytime by Disconnect → Connect again.",
        ],
        setupNotes:
            "This connector is live today for inbound file ingest. Use it as a bridge while SAP/MES-specific pollers are rolled out. Outbound webhook receives JSON after AI processing when enabled in a later worker.",
    },
    {
        id: "sql_csv_drop",
        name: "SQL Export / CSV Drop",
        category: "generic",
        description: "Scheduled DB export or CSV/Excel drop from legacy factory databases.",
        directions: "both",
        fields: [
            { key: "connectionString", label: "Read-only DB connection string (optional)", type: "password", secret: true },
            { key: "queryOrView", label: "SQL view / query name", type: "text", placeholder: "dbo.v_daily_qc_export" },
            { key: "dropFolder", label: "CSV/Excel drop folder path", type: "text", placeholder: "\\\\server\\exports\\csv" },
            { key: "filePattern", label: "File name pattern", type: "text", placeholder: "qc_*.csv" },
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
    */
];

export function getIntegrationById(id: string): IntegrationCatalogItem | undefined {
    return INTEGRATION_CATALOG.find((i) => i.id === id);
}

export function catalogProviderIds(): string[] {
    return INTEGRATION_CATALOG.map((i) => i.id);
}

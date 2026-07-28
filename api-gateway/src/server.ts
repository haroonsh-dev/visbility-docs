import dotenv from 'dotenv';
import app from './app';
import dbConnect from './config/db';
import logger from './utils/logger';
import { seedPlansOnBoot } from './services/planSeed';
import { runDueGoogleDriveSyncs } from './services/integrationSyncService';
import { runDueEmailReports } from './services/emailReportService';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5100', 10);

async function start() {
    await dbConnect();
    await seedPlansOnBoot();
    app.listen(PORT, () => {
        logger.info(`Visibility Docs AI API listening on http://localhost:${PORT}`);
        logger.info(`OpenRemote enabled: ${process.env.OPENREMOTE_ENABLED !== 'false'}`);
    });

    // Auto-sync Google Drive + due email reports (interval / daily / weekly)
    const tickMs = 60 * 1000;
    const runTicks = () => {
        runDueGoogleDriveSyncs().catch((err) => {
            logger.warn(`[integrations] auto-sync tick failed: ${err?.message || err}`);
        });
        runDueEmailReports().catch((err) => {
            logger.warn(`[email-reports] tick failed: ${err?.message || err}`);
        });
    };
    setInterval(runTicks, tickMs);
    // First tick shortly after boot
    setTimeout(runTicks, 15_000);
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});

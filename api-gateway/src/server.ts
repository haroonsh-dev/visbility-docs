import dotenv from 'dotenv';
import app from './app';
import dbConnect from './config/db';
import logger from './utils/logger';
import { seedPlansOnBoot } from './services/planSeed';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5100', 10);

async function start() {
    await dbConnect();
    await seedPlansOnBoot();
    app.listen(PORT, () => {
        logger.info(`Visibility Docs AI API listening on http://localhost:${PORT}`);
        logger.info(`OpenRemote enabled: ${process.env.OPENREMOTE_ENABLED !== 'false'}`);
    });
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});

import mongoose, { Document, Schema } from 'mongoose';

export interface IIntegrationConnection extends Document {
    connectionId: string;
    organizationId: string;
    providerId: string;
    label: string;
    config: Record<string, string | number | boolean | null>;
    secrets: Record<string, string>;
    ingestApiKey: string;
    isActive: boolean;
    intervalMinutes: number;
    direction: 'inbound' | 'outbound' | 'both';
    lastSyncAt?: Date | null;
    lastStatus?: string | null;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

const IntegrationConnectionSchema = new Schema<IIntegrationConnection>(
    {
        connectionId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        providerId: { type: String, required: true, index: true },
        label: { type: String, required: true },
        config: { type: Schema.Types.Mixed, default: {} },
        secrets: { type: Schema.Types.Mixed, default: {} },
        ingestApiKey: { type: String, required: true, unique: true, index: true },
        isActive: { type: Boolean, default: true },
        intervalMinutes: { type: Number, default: 15 },
        direction: { type: String, enum: ['inbound', 'outbound', 'both'], default: 'both' },
        lastSyncAt: { type: Date, default: null },
        lastStatus: { type: String, default: null },
        createdBy: { type: String, required: true },
    },
    { timestamps: true }
);

IntegrationConnectionSchema.index({ organizationId: 1, providerId: 1 }, { unique: true });

export default mongoose.model<IIntegrationConnection>('IntegrationConnection', IntegrationConnectionSchema);

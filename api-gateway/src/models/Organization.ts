import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    organizationId: string;
    organizationName: string;
    contactEmail?: string;
    status: 'active' | 'inactive';
    subscriptionPlan?: string;
    openRemoteRealm?: string | null;
    groqApiKey?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
    {
        organizationId: { type: String, required: true, unique: true },
        organizationName: { type: String, required: true },
        contactEmail: { type: String },
        status: { type: String, enum: ['active', 'inactive'], default: 'active' },
        subscriptionPlan: { type: String, default: 'free' },
        openRemoteRealm: { type: String, default: null },
        groqApiKey: { type: String, default: null },
    },
    { timestamps: true }
);

export default mongoose.model<IOrganization>('Organization', OrganizationSchema);

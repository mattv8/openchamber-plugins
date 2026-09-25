import { z } from 'zod';

/** External values read by the real-host Git Graph fixture runner. */
export const PortAddressSchema = z.object({ port: z.number().int().positive().max(65535) });
export const ServiceEnvelopeSchema = z.object({ body: z.string() });
export const SessionIdentitySchema = z.object({ id: z.string().min(1) });
const InstalledGuestSchema = z.object({
  id: z.string(), entry: z.string().optional(), pageEntry: z.string().optional(), statusEntry: z.string().optional(),
  capabilities: z.object({ requested: z.array(z.string()) }).optional(),
});
export const GuestCatalogSchema = z.object({ guests: z.array(InstalledGuestSchema) });
export type InstalledGuest = z.infer<typeof InstalledGuestSchema>;

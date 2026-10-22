import { serverAllowedFor } from "./approval-payload";

type Person = { id: string; email: string; admin: boolean };
type ConnectorRow = { createdBy: string | null; allowedEmails: string[] | null };

export function startingAccess(person: Person): string[] | null {
  return person.admin ? null : [person.email.toLowerCase()];
}

export function canUseConnector(person: Person, server: ConnectorRow) {
  return person.admin || serverAllowedFor(server.allowedEmails, person.email);
}

export function canManageConnector(person: Person, server: ConnectorRow) {
  return person.admin || (server.createdBy !== null && server.createdBy === person.id);
}

export function accessChangeAllowed(person: Person, everyone: boolean) {
  return person.admin || !everyone;
}

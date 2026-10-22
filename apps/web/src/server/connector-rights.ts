import { serverAllowedFor } from "./approval-payload";

type Person = { id: string; email: string; admin: boolean };
type ConnectorRow = { createdBy: string | null; allowedEmails: string[] | null };

// Anyone can add a connector. One added by an admin starts open to everyone;
// one added by anyone else starts as theirs alone until they share it.
export function startingAccess(person: Person): string[] | null {
  return person.admin ? null : [person.email.toLowerCase()];
}

export function canUseConnector(person: Person, server: ConnectorRow) {
  return person.admin || serverAllowedFor(server.allowedEmails, person.email);
}

export function canManageConnector(person: Person, server: ConnectorRow) {
  return person.admin || (server.createdBy !== null && server.createdBy === person.id);
}

// Opening a connector to the whole company stays with admins: a person shares
// what they added by naming who else gets it.
export function accessChangeAllowed(person: Person, everyone: boolean) {
  return person.admin || !everyone;
}

export interface DocumentRevision {
  id: string;
  number: number;
  content: string;
  version: string;
  source: "baseline" | "external" | "review";
  createdAt: string;
  completedAt: string | null;
  actor: "agent" | "user" | "unknown";
  author?: string;
}

export interface RecoveryPoint {
  id: string;
  documentPath: string;
  content: string;
  version: string;
  createdAt: string;
  reason: string;
}

export interface RevisionChange {
  id: string;
  revision: number;
  kind: "addition" | "deletion" | "replacement";
  from: number;
  to: number;
  before: string;
  after: string;
  beforeFormat?: string;
  afterFormat?: string;
}

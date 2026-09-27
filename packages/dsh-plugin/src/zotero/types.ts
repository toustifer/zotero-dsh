/**
 * dsh-zotero — Zotero data model (source-independent normalization).
 *
 * The Local API (127.0.0.1:23119) and the Web API (api.zotero.org) return the
 * same v3 JSON shape; this module normalizes both into one stable projection
 * so tools behave identically regardless of the active source.
 */

export type ZoteroSource = 'local' | 'web' | 'none'

export interface ZoteroCreator {
  creatorType: string
  firstName: string
  lastName: string
  /** Single-field/name creators (field mode) carry `name`. */
  name?: string
  fullName: string
}

export interface ZoteroAttachment {
  key: string
  title: string
  contentType: string
  linkMode: 'imported_file' | 'linked_file' | 'linked_url' | 'imported_url' | string
  /** Best-effort file name (attachment title is the API's canonical source). */
  filename?: string
  /** Local/Web API path to download the raw file bytes (GET). */
  downloadPath: string
  /** True when the attachment is an importable/linkable local PDF-like file. */
  isPdf: boolean
}

export interface ZoteroNote {
  key: string
  note: string
  /** First line of the note, truncated for display. */
  title: string
}

export interface ZoteroAnnotation {
  key: string
  annotationText: string
  annotationComment: string
  color: string
  /** 1-based page/positional hints when present. */
  pageLabel?: string
}

export interface ZoteroItemSummary {
  key: string
  version: number
  itemType: string
  title: string
  creators: ZoteroCreator[]
  date: string
  /** First 4-digit year found in `date`. */
  year?: number
  abstractNote: string
  doi: string
  url: string
  publicationTitle: string
  journalAbbreviation: string
  extra: string
  tags: string[]
  /** Collection keys the item belongs to. */
  collections: string[]
  /** Child counts (attachments + notes). */
  numChildren: number
  numNotes: number
  dateAdded: string
  dateModified: string
  library: { type: string; id: number; name?: string }
  /** Where this record came from. */
  source: ZoteroSource
  /** Parent item key when this is a child item. */
  parentItem?: string
}

export interface ZoteroItemDetail extends ZoteroItemSummary {
  attachments: ZoteroAttachment[]
  notes: ZoteroNote[]
  annotations: ZoteroAnnotation[]
}

export interface ZoteroCollection {
  key: string
  name: string
  parentKey: string | null
  /** Number of direct child items (meta.numItems when available). */
  itemCount?: number
  /** Depth in the tree; -1 for root-level collections. */
  depth: number
}

export interface ZoteroHealthResult {
  ok: boolean
  source: ZoteroSource
  /** Local API base actually probed ('' when not attempted). */
  localBase: string
  /** Web API user id ('' when not configured). */
  webUserId: string
  latencyMs: number
  error: string
  hint: string
}

export interface ZoteroSearchParams {
  query?: string
  /** qmode: titleCreatorYear (default), everything (fulltext), title, creators, year, tags, abstractNote. */
  qmode?: string
  tag?: string
  collectionKey?: string
  itemType?: string
  sort?: string
  direction?: 'asc' | 'desc'
  limit?: number
  start?: number
}

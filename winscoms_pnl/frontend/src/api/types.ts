export type Role = "admin" | "member" | "viewer";

export interface User { id: string; email: string; full_name: string | null; is_active: boolean; is_platform_admin: boolean }
export interface Membership { organization_id: string; organization_name: string; role: Role }
export interface Me { user: User; memberships: Membership[]; csrf_token: string }

export type LineStatus = "ok" | "incomplete" | "missing" | "blocked" | "header" | "not_applicable";
export interface Contribution { source: string; [k: string]: unknown }
export interface CellValue { value: string | null; preliminary: string | null; status: LineStatus; notes: string[]; contributions: Contribution[] }
export interface PnlLine {
  id: string; name: string; parent: string | null; level: number; kind: string; memo: boolean; note: string | null;
  values: Record<string, CellValue>;
}
export interface PnlReport {
  date_from: string; date_to: string; granularity: "total" | "month" | "day"; currency: string; account_id: string | null;
  settings: { tax_regime: "usn_income" | "osno"; usn_rate: string; profit_tax_rate: string; vat_sales_rate: string; vat_services_rate: string };
  quality: { transactions_by_status: Record<string, number>; excluded_pending_amounts: Record<string, string>; import_issues: number };
  coverage: { days_in_range: number; days_with_data: number; missing_days: string[]; missing_days_count: number };
  periods: string[]; lines: PnlLine[];
}

export interface SellerAccount { id: string; marketplace: string; name: string; token_hint: string | null; status: "active" | "auth_error" | "disconnected"; last_validated_at: string | null; last_sync_at: string | null; created_at: string }
export interface SyncJob {
  id: string; seller_account_id: string; kind: string; period_from: string; period_to: string;
  status: "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled";
  pages_fetched: number; records_fetched: number; records_saved: number; attempts: number;
  error_code: string | null; error_message: string | null; scheduled_at: string; started_at: string | null; finished_at: string | null; created_at: string;
}
export interface NormalizationSummary { raw_records: number; normalized: number; by_status: Record<string, number>; by_category: Record<string, number>; needs_attention: number }

export interface ManualEntry { id: number; entry_date: string; category: string; amount: string; currency: string; description: string | null; seller_account_id: string | null; marketplace: string | null; created_at: string }
export interface Cost { id: number; nm_id: number; vendor_code: string | null; cost_per_unit: string; currency: string; valid_from: string }
export interface OrgSettings { tax_regime: "usn_income" | "osno"; usn_rate: string; profit_tax_rate: string; vat_sales_rate: string; vat_services_rate: string }
export interface Organization { id: string; name: string; is_active: boolean }
export interface AdminUser { id: string; email: string; full_name: string | null; is_active: boolean; is_platform_admin: boolean }
export interface DrilldownResponse { line: string; kind: "import" | "manual" | "cogs"; items: Record<string, unknown>[] }

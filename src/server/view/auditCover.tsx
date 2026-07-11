/**
 * Audit Package cover summary — the human entry point at the package
 * root. Print-styled, grayscale-safe, every figure from stored records.
 * Rendered to PDF by headless Chromium when available; otherwise the
 * printable HTML itself ships in the package (honestly labelled in the
 * manifest).
 */
import { h, renderDocument } from "./jsx";
import type { AuditCoverData } from "../services/auditPackage";

const money = (n: number): string => "$" + n.toLocaleString("en-US");
const ts = (iso: string): string => iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { font: 10.5pt/1.5 Georgia, 'Times New Roman', serif; color: #14202e; padding: 40px 48px; }
  .mast { border-bottom: 3px double #14202e; padding-bottom: 14px; margin-bottom: 22px; }
  .mast .brand { font: 700 9pt Arial, sans-serif; letter-spacing: 2.5px; color: #43536a; }
  h1 { font-size: 19pt; font-weight: 700; margin: 6px 0 2px; }
  .sub { color: #43536a; font-size: 10pt; }
  h2 { font: 700 9.5pt Arial, sans-serif; letter-spacing: 1.4px; text-transform: uppercase;
       border-bottom: 1px solid #b9c2cf; padding-bottom: 4px; margin: 22px 0 10px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 5px 8px; text-align: left; vertical-align: top; font-size: 10pt; }
  .kv td:first-child { width: 38%; color: #43536a; font-family: Arial, sans-serif; font-size: 8.5pt;
       letter-spacing: .6px; text-transform: uppercase; padding-top: 7px; }
  .kv td:last-child { font-variant-numeric: tabular-nums; }
  .kv tr { border-bottom: 1px solid #e6eaef; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 34px; }
  .flag { border: 1.5px solid #14202e; padding: 10px 14px; margin: 14px 0; font-family: Arial, sans-serif; }
  .flag b { letter-spacing: 1px; }
  .flag.warn { background: #f6efe2; }
  .flag ul { margin: 6px 0 0 18px; font-size: 9pt; }
  .muted { color: #5b6b7f; font-size: 9pt; }
  .sections { columns: 2; font-size: 9.5pt; }
  .sections li { margin-bottom: 3px; }
  .foot { margin-top: 28px; border-top: 1px solid #b9c2cf; padding-top: 10px;
          font: 8.5pt Arial, sans-serif; color: #5b6b7f; }
`;

export function renderAuditCover(d: AuditCoverData): string {
  const clean = d.integrityState === "CLEAN";
  return renderDocument(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{`Audit Package — ${d.project.name}`}</title>
        <style>{CSS}</style>
      </head>
      <body>
        <div className="mast">
          <div className="brand">OPENBUILD VERIFY · PROJECT AUDIT PACKAGE</div>
          <h1>{d.project.name}</h1>
          <div className="sub">
            {d.organizationName} · {d.project.location}
          </div>
        </div>

        <table className="kv">
          <tr><td>Package ID</td><td>{d.packageId} · version {d.packageVersion} · schema v1</td></tr>
          <tr><td>Generated</td><td>{ts(d.generatedAt)} by {d.generatedBy}</td></tr>
          <tr><td>Reporting point (as-of)</td><td>{ts(d.asOf)} — registers exclude records after this timestamp</td></tr>
          <tr><td>Configuration version</td><td>v{d.configurationVersion}</td></tr>
        </table>

        <div className={`flag ${clean ? "" : "warn"}`}>
          <b>{clean ? "INTEGRITY: CLEAN" : "READY WITH INTEGRITY WARNING"}</b>
          {" — "}Evidence Ledger {d.ledgerIntegrity === "INTACT" ? "chain intact" : d.ledgerIntegrity}.
          {clean
            ? " All configuration snapshot hashes, release transitions, approval records and accessible evidence objects validate."
            : ""}
          {!clean ? (
            <ul>
              {d.integrityWarnings.map((w) => (
                <li>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="grid">
          <div>
            <h2>Financial position</h2>
            <table className="kv">
              <tr><td>Controlled amount</td><td>{money(d.controlledAmount)}</td></tr>
              <tr><td>Released (governed)</td><td>{money(d.released)}</td></tr>
              <tr><td>Held</td><td>{money(d.held)}</td></tr>
              <tr><td>Retainage withheld</td><td>{money(d.retainageWithheld)}</td></tr>
              <tr><td>Retainage released</td><td>{money(d.retainageReleased)}</td></tr>
              <tr><td>Retainage remaining</td><td>{money(d.retainageRemaining)}</td></tr>
            </table>
          </div>
          <div>
            <h2>Governance state</h2>
            <table className="kv">
              <tr><td>Verified milestones</td><td>{d.verifiedMilestones} of {d.totalMilestones}</td></tr>
              <tr><td>Pending approvals</td><td>{d.pendingApprovals}</td></tr>
              <tr><td>Open exceptions</td><td>{d.openExceptions}</td></tr>
              <tr><td>Approved change orders</td><td>{d.approvedChangeOrders}{d.approvedChangeOrders ? ` (${money(d.approvedChangeValue)})` : ""}</td></tr>
              <tr><td>Evidence Ledger</td><td>{d.ledgerIntegrity === "INTACT" ? "CHAIN INTACT" : d.ledgerIntegrity}</td></tr>
            </table>
          </div>
        </div>

        <h2>Package contents</h2>
        <ul className="sections">
          {d.sections.map((s) => (
            <li>{s.replace(/_/g, " ")}</li>
          ))}
          <li>manifest.json — hashed file inventory</li>
        </ul>
        <p className="muted" style="margin-top:10px">
          Every register references governed application records (Evidence Ledger,
          configuration snapshots, approval records, financial state events). The
          package assembles these sources; it never rewrites them. Evidence media and
          communication transcripts are not included. File-level sha256 hashes and the
          manifest hash allow independent re-verification of package integrity.
        </p>

        <div className="foot">
          OpenBuild Verify · demo environment · virtual project account ledger (no real
          bank movement) · package {d.packageId}
        </div>
      </body>
    </html>
  );
}

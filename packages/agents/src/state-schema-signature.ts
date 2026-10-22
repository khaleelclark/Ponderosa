import type Database from "better-sqlite3";
import { STATE_READ_LIMITS as limits, withStateReads } from "./state-read-budget.js";

const fail = (): never => { throw new Error("unsupported bounded state schema metadata"); };
// Branch workflow tables bring the canonical schema to under 400 KiB serialized and
// over 1 MiB under the conservative pre-materialization accounting. Keep a fixed
// 2 MiB schema envelope; ordinary row and statement limits remain unchanged.
const schemaMetadataBytes = 2 * limits.metadataBytes;
type ObjectRow = { type: string; name: string; tbl_name: string; sql: string | null };
export interface IndexOrdinalReceipt { table: string; name: string; seq: number }

/** Checkout line endings are not schema changes. Preserve quoted SQL bytes,
 * including newlines in literals/identifiers; comments do not open quotes.
 * All other whitespace and declarations remain exact. SQLite bracket quoting
 * ends at the first ], while the other quotes escape by doubling themselves. */
function schemaSqlLineEndings(sql: string): string {
  const input = Buffer.from(sql), output = Buffer.allocUnsafe(input.length);
  let written = 0, quote = 0;
  let comment: "line" | "block" | undefined;
  for (let i = 0; i < input.length; i++) {
    const byte = input[i]!, next = input[i + 1];
    if (quote) {
      output[written++] = byte;
      if (byte === quote) {
        if (quote !== 93 && next === quote) { output[written++] = next; i++; }
        else quote = 0;
      }
      continue;
    }
    if (byte === 13 && next === 10) {
      output[written++] = 10; i++;
      if (comment === "line") comment = undefined;
      continue;
    }
    output[written++] = byte;
    if (comment === "line") { if (byte === 10) comment = undefined; continue; }
    if (comment === "block") {
      if (byte === 42 && next === 47) { output[written++] = next; i++; comment = undefined; }
      continue;
    }
    if ((byte === 45 && next === 45) || (byte === 47 && next === 42)) {
      output[written++] = next; i++;
      comment = byte === 45 ? "line" : "block";
    } else if (byte === 39 || byte === 34 || byte === 96) quote = byte;
    else if (byte === 91) quote = 93;
  }
  return output.subarray(0, written).toString("utf8");
}

/** Raw index_list seq is retained separately as an enumeration receipt. It is
 * not a key position and varies with index creation order. Signature ordering
 * is explicitly by index name; index_xinfo seqno/direction/collation/key flags,
 * unique/origin/partial and all other declaration bytes remain exact. */
export function stateSchemaMetadata(sqlite: Database.Database): { signature: string; indexOrdinals: IndexOrdinalReceipt[] } {
  return withStateReads(sqlite, reads => {
    reads.budget.allocate(2 * schemaMetadataBytes);
    let metadataBytes = 4096;
    const reserve = (bytes: number): void => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > schemaMetadataBytes - metadataBytes) fail();
      metadataBytes += bytes;
    };
    const n = reads.population("sqlite_master");
    if (n > limits.objects) fail();
    const objects = reads.all<ObjectRow>("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
      ["type", "name", "tbl_name", "sql"], limits.objects, schemaMetadataBytes, n, [], reserve).map(row => {
      if (!row.sql?.includes("\r\n")) return row;
      // Two bounded UTF-8 buffers plus the resulting UTF-16 string. Charge the
      // existing invocation before allocating; no metadata/work ceiling changes.
      reads.budget.allocate(4 * Buffer.byteLength(row.sql));
      return { ...row, sql: schemaSqlLineEndings(row.sql) };
    });
    const listedCount = reads.population("pragma_table_list");
    if (listedCount > limits.objects + 2) fail();
    const flags = reads.all<{ schema: string; name: string; type: string; ncol: number; wr: number; strict: number }>(
      "SELECT schema,name,type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' ORDER BY name",
      ["schema", "name", "type", "ncol", "wr", "strict"], limits.objects + 2, schemaMetadataBytes, listedCount, [], reserve);
    const indexOrdinals: IndexOrdinalReceipt[] = [];
    const tables = objects.filter(row => row.type === "table").map(row => {
      reserve(256 + 6 * Buffer.byteLength(row.name));
      const columnCount = reads.population(`pragma_table_xinfo('${row.name.replaceAll("'", "''")}')`);
      if (columnCount > limits.columns) fail();
      const columns = reads.all("SELECT cid,name,type,\"notnull\",dflt_value,pk,hidden FROM pragma_table_xinfo(?) ORDER BY cid",
        ["cid", "name", "type", "notnull", "dflt_value", "pk", "hidden"], limits.columns, schemaMetadataBytes, columnCount, [row.name], reserve);
      const count = reads.population(`pragma_index_list('${row.name.replaceAll("'", "''")}')`);
      if (count > limits.objects) fail();
      const raw = reads.all<{ seq: number; name: string; unique: number; origin: string; partial: number }>(
        'SELECT seq,name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY name',
        ["seq", "name", "unique", "origin", "partial"], limits.objects, schemaMetadataBytes, count, [row.name], reserve);
      const indexes = raw.map(({ seq, ...index }) => {
        reserve(256 + 6 * (Buffer.byteLength(row.name) + Buffer.byteLength(index.name)));
        indexOrdinals.push({ table: row.name, name: index.name, seq });
        return index;
      });
      const keys = indexes.map(index => {
        const count = reads.population(`pragma_index_xinfo('${index.name.replaceAll("'", "''")}')`);
        if (count > limits.columns + 1) fail();
        reserve(128 + 6 * Buffer.byteLength(index.name));
        return { name: index.name, columns: reads.all(
          'SELECT seqno,cid,name,"desc",coll,"key" FROM pragma_index_xinfo(?) ORDER BY seqno',
          ["seqno", "cid", "name", "desc", "coll", "key"], limits.columns + 1, schemaMetadataBytes, count, [index.name], reserve) };
      });
      return { name: row.name, columns, indexes, keys };
    });
    let versions: unknown[] = [];
    if (objects.some(row => row.type === "table" && row.name === "_schema_version")) {
      const count = reads.population("_schema_version");
      if (count > limits.objects) fail();
      versions = reads.all("SELECT name FROM _schema_version ORDER BY name", ["name"], limits.objects, schemaMetadataBytes, count, [], reserve);
    }
    const engine = reads.all("SELECT sqlite_version() version", ["version"], 1, 1024, 1, [], reserve)[0];
    const userVersion = reads.scalar("SELECT user_version n FROM pragma_user_version", 1).n;
    const applicationId = reads.scalar("SELECT application_id n FROM pragma_application_id", 1).n;
    // Every nested value, array framing and wrapper was reserved before read.
    const signature = JSON.stringify({ engine, userVersion, applicationId, objects, versions, flags, tables });
    if (Buffer.byteLength(signature) > metadataBytes || Buffer.byteLength(signature) > schemaMetadataBytes) fail();
    return { signature, indexOrdinals };
  });
}
/** Complete expected/actual metadata from private existing handles only. */
export function stateSchemaSignature(sqlite: Database.Database): string { return stateSchemaMetadata(sqlite).signature; }

// ============================================================
// YYC CASH LOAN — MASTER REFERENCE LIST
// Edit this array to add or remove reference codes.
// Baserow is the live source of truth for status across devices.
// ============================================================

const MASTER_REFERENCES = [
    "Z06852991796282",
    "Z0685299179C8C1",
    "YYC-003",
    "YYC-004",
    "YYC-005",
    "YYC-006",
    "YYC-007",
    "YYC-008",
    "YYC-009",
    "YYC-010"
];

// ============================================================
// BASEROW CONFIG
// Table     : 503285
// Reference : field_8915126  → column name "Reference"
// Status    : field_8915236  → column name "status"
//               single select — option IDs:
//               6438630 = "used"   |   6438631 = "issued"
//               null (no selection) = unused / available
// issuedAt  : stored in "Email" field (text) as Unix timestamp string
// Row marker: "cardHolder" field contains "REF_TRACK"
//             (isolates reference rows from other table data)
// ============================================================
const BASEROW_TABLE  = '503285';
const BASEROW_TOKEN  = 'Token LG6hnTBxgBG78FueElsSwpHRd4Wep1oL';
const BASEROW_API    = `https://api.baserow.io/api/database/rows/table/${BASEROW_TABLE}`;
const ISSUED_MS      = 30 * 60 * 1000; // 30 minutes

// Status priority (higher wins when multiple rows exist for same reference)
const STATUS_PRIORITY = { used: 3, issued: 2, available: 1 };

// ============================================================
// LOW-LEVEL BASEROW HELPERS
// ============================================================
async function _brGet(params) {
    try {
        const qs  = new URLSearchParams({ user_field_names: 'true', page_size: '200', ...params });
        const res = await fetch(`${BASEROW_API}/?${qs}`, {
            headers: { Authorization: BASEROW_TOKEN }
        });
        if (!res.ok) return null;
        return await res.json();
    } catch(e) { return null; }
}

async function _brPost(body) {
    try {
        const res = await fetch(`${BASEROW_API}/?user_field_names=true`, {
            method:  'POST',
            headers: { Authorization: BASEROW_TOKEN, 'Content-Type': 'application/json' },
            body:    JSON.stringify(body)
        });
        if (!res.ok) return null;
        return await res.json();
    } catch(e) { return null; }
}

async function _brPatch(rowId, body) {
    if (!rowId) return null;
    try {
        const res = await fetch(`${BASEROW_API}/${rowId}/?user_field_names=true`, {
            method:  'PATCH',
            headers: { Authorization: BASEROW_TOKEN, 'Content-Type': 'application/json' },
            body:    JSON.stringify(body)
        });
        if (!res.ok) return null;
        return await res.json();
    } catch(e) { return null; }
}

// ============================================================
// FETCH LIVE REFERENCE STATUS MAP FROM BASEROW
//
// Returns: { "YYC-001": { status, issuedAt, rowId }, ... }
//   status = "available" | "issued" | "used"
//
// Rules applied:
//   - "used"   = permanently blocked — never re-issued
//   - "issued" + age < 30 min = currently taken
//   - "issued" + age >= 30 min = expired → auto-released to null in Baserow
//   - null / no row = available
//
// If a reference has multiple rows, the highest-priority status wins:
//   used (3) > issued (2) > available (1)
// ============================================================
async function fetchRefStatusMap() {
    const map      = {}; // ref → { status, issuedAt, rowId }
    const expiries = []; // rowIds of expired-issued rows to PATCH back to null

    // Fetch all reference-tracking rows (cardHolder contains "REF_TRACK")
    const data = await _brGet({ filter__cardHolder__contains: 'REF_TRACK' });
    if (!data || !data.results) return map;

    const now = Date.now();

    data.results.forEach(row => {
        const ref = (row['Reference'] || '').trim().toUpperCase();
        if (!ref) return; // skip rows with no reference code

        const statusObj = row['status'];
        const statusVal = statusObj
            ? (typeof statusObj === 'object' ? (statusObj.value || '') : String(statusObj)).toLowerCase()
            : '';
        const issuedAtRaw = Number(row['Email']);
        const issuedAt    = !isNaN(issuedAtRaw) ? issuedAtRaw : null; // guard: "used" rows store text in Email
        const rowId     = row['id'];

        // Resolve the effective status for this row
        let resolvedStatus;
        if (statusVal === 'used') {
            resolvedStatus = 'used';
        } else if (statusVal === 'issued') {
            const age = issuedAt ? now - issuedAt : Infinity;
            if (age >= ISSUED_MS) {
                // Issued but expired — auto-release in background
                expiries.push(rowId);
                resolvedStatus = 'available';
            } else {
                resolvedStatus = 'issued';
            }
        } else {
            resolvedStatus = 'available'; // null or unknown = unused
        }

        // Apply priority: only overwrite if this row has higher priority
        const existing = map[ref];
        if (!existing || STATUS_PRIORITY[resolvedStatus] > STATUS_PRIORITY[existing.status]) {
            map[ref] = { status: resolvedStatus, issuedAt, rowId };
        }
    });

    // Auto-release expired issued rows back to null/unused in Baserow (fire and forget)
    expiries.forEach(id => _brPatch(id, { status: null }));

    return map;
}

// ============================================================
// FIND THE FIRST AVAILABLE REFERENCE
// Returns a reference code string, or null if none available.
// ============================================================
function pickAvailableRef(statusMap) {
    for (const ref of MASTER_REFERENCES) {
        const key   = ref.trim().toUpperCase();
        const entry = statusMap[key];
        // No entry = unused/available; or entry explicitly resolved to 'available'
        if (!entry || entry.status === 'available') return key;
    }
    return null; // all references are actively issued or permanently used
}

// ============================================================
// POST: MARK REFERENCE AS ISSUED
// Creates a new row in Baserow with status "issued".
// Returns the Baserow row id to store in sessionStorage.
// ============================================================
async function postRefIssued(ref) {
    const row = await _brPost({
        Reference:  ref,
        status:     'issued',             // matches the option value in field_8915236
        Email:      String(Date.now()),   // issuedAt timestamp for 30-min tracking
        cardHolder: 'REF_TRACK'          // identifies this as a reference-tracking row
    });
    return row ? row.id : null;
}

// ============================================================
// PATCH: MARK REFERENCE AS USED (payment confirmed)
// Updates the existing issued row to "used" — permanent.
// All devices will see this reference as taken forever.
// ============================================================
async function postRefUsed(rowId, ref, payerName) {
    // Email field (field_3977956) receives name + reference combined for easy admin reading
    const emailValue = `${payerName} | ${ref}`;

    if (rowId) {
        // Best path: PATCH the exact issued row to "used"
        await _brPatch(rowId, {
            status:     'used',
            Email:      emailValue,              // field_3977956: "John Doe | YYC-001"
            cardHolder: `REF_TRACK|${payerName}` // admin marker + payer name
        });
    } else {
        // Fallback: create a fresh "used" row (rowId lost, e.g. session cleared)
        await _brPost({
            Reference:  ref || '',
            status:     'used',
            Email:      emailValue,              // field_3977956: "John Doe | YYC-001"
            cardHolder: `REF_TRACK|${payerName}`
        });
    }
}

/**
 * GSTIN validation — format + the official check-digit algorithm.
 *
 * A GSTIN is 15 characters: 2-digit state code, 10-char PAN, entity number,
 * 'Z' by default, and a check character computed with a base-36 weighted sum
 * (the same scheme the GST portal uses). A typo'd or fabricated GSTIN on an
 * invoice means the buyer can't claim input tax credit on it — that's real
 * money, and no SMB tool checks it at the moment the invoice arrives.
 */

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function computeCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i]);
    const factor = i % 2 === 0 ? 1 : 2;
    const product = value * factor;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return CHARSET[check];
}

function validateGSTIN(input) {
  if (!input) return { valid: false, reason: 'missing' };
  const gstin = String(input).toUpperCase().replace(/\s/g, '');
  if (gstin.length !== 15) return { valid: false, gstin, reason: 'GSTIN must be 15 characters' };
  if (!FORMAT.test(gstin)) return { valid: false, gstin, reason: 'GSTIN format is invalid' };
  const stateCode = gstin.slice(0, 2);
  if (!STATE_CODES[stateCode]) return { valid: false, gstin, reason: `Unknown state code ${stateCode}` };
  const expected = computeCheckChar(gstin.slice(0, 14));
  if (expected !== gstin[14]) {
    return { valid: false, gstin, reason: `Check digit should be ${expected}, found ${gstin[14]} — likely a typo or a fabricated number` };
  }
  return { valid: true, gstin, state: STATE_CODES[stateCode], stateCode, pan: gstin.slice(2, 12) };
}

// Build a valid GSTIN from a state code + PAN-like string (used for demo data).
function makeGSTIN(stateCode, pan, entity = '1') {
  const first14 = `${stateCode}${pan}${entity}Z`;
  return first14 + computeCheckChar(first14);
}

module.exports = { validateGSTIN, makeGSTIN, STATE_CODES };

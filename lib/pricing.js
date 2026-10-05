// Works out what a customer is charged for one "buying unit" of a product.
//
//   Has a case price  -> sold by the case, charged the supplier's case price
//                        (or the special case price while on special).
//   No case price     -> left as it was: charged the unit price (or special
//                        unit price). We'll revisit these separately.
//
// "unit_price" in the supplier file is the price of ONE unit inside a case
// (e.g. one pack of 24 forks), so it is never charged on its own for an item
// that has a case price.

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// "24/PK X 24/CS" -> 24, "12/PK x 36/CASE" -> 36, "50/CS" -> 50. Returns null
// when the description doesn't say.
function unitsPerCase(description) {
  const m = /(\d+)\s*\/\s*(?:CS|CASE|CTN)\b/i.exec(description || '');
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : null;
}

function pricing(p) {
  const unitPrice = num(p.unit_price);
  const casePrice = num(p.case_price);
  const special = num(p.special_price);
  const specialCase = num(p.special_case_price);
  const n = unitsPerCase(p.description);
  const onSpecial = special !== null;

  // No case price: leave the item exactly as before (per unit).
  if (casePrice === null) {
    const price = onSpecial ? special : unitPrice;
    return {
      uom: 'EACH',
      per: 'each',
      price: price === null ? 0 : price,
      regularPrice: unitPrice === null ? 0 : unitPrice,
      onSpecial,
      unitsPerCase: n,
      packPrice: null,
      sub: ''
    };
  }

  let specialCasePrice = null;
  if (onSpecial) {
    if (specialCase !== null) specialCasePrice = specialCase;
    else if (n) specialCasePrice = round2(special * n);
    else if (unitPrice) specialCasePrice = round2((casePrice * special) / unitPrice);
    else specialCasePrice = special;
  }

  return {
    uom: 'CASE',
    per: 'case',
    price: onSpecial ? specialCasePrice : casePrice,
    regularPrice: casePrice,
    onSpecial,
    unitsPerCase: n,
    packPrice: onSpecial ? special : unitPrice,
    sub: ''
  };
}

module.exports = { pricing, unitsPerCase, round2 };

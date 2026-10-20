// Lagos pilot delivery zones. The fees are PLACEHOLDERS: replace them with the
// rate card agreed in writing with Fez (or whichever courier you sign with).
export const ZONES = [
  { id: 'ikeja', name: 'Ikeja / Maryland / Ojota / Ogba', group: 'mainland' },
  { id: 'yaba', name: 'Yaba / Surulere / Ebute-Metta / Mushin', group: 'mainland' },
  { id: 'gbagada', name: 'Gbagada / Anthony / Ketu / Magodo', group: 'mainland' },
  { id: 'festac', name: 'Festac / Amuwo-Odofin / Mile 2 / Satellite Town', group: 'mainland' },
  { id: 'ikotun', name: 'Ikotun / Egbeda / Idimu / Alimosho', group: 'outer' },
  { id: 'ikorodu', name: 'Ikorodu', group: 'outer' },
  { id: 'island', name: 'Lagos Island / Ikoyi / Victoria Island', group: 'island' },
  { id: 'lekki', name: 'Lekki Phase 1 / Oniru / Ikate / Chevron', group: 'island' },
  { id: 'ajah', name: 'Ajah / Sangotedo / Abraham Adesanya', group: 'far_island' },
];

const NAIRA = {
  mainland: { mainland: 2500, outer: 3500, island: 3500, far_island: 4500 },
  outer: { mainland: 3500, outer: 3500, island: 4500, far_island: 5500 },
  island: { mainland: 3500, outer: 4500, island: 2500, far_island: 3500 },
  far_island: { mainland: 4500, outer: 5500, island: 3500, far_island: 3000 },
};

export const zoneById = (id) => ZONES.find((z) => z.id === id) || null;

export function deliveryFeeKobo(fromZoneId, toZoneId) {
  const from = zoneById(fromZoneId);
  const to = zoneById(toZoneId);
  if (!from || !to) return null;
  return NAIRA[from.group][to.group] * 100;
}

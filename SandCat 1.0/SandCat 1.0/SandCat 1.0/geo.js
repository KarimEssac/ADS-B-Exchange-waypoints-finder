function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R_km = 6371.0;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const km = R_km * c;
  return km / 1.852;
}

function binKey1deg(lat, lon) {
  return `${Math.floor(lat)}|${Math.floor(lon)}`;
}

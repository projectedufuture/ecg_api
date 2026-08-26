const mongoose = require('mongoose');

// Reverse-geocoding results are cached by rounded coordinate so that repeated
// location pings from the same place cost exactly one upstream request. This
// matters for two reasons: the free Nominatim service asks for no more than one
// request per second, and a wearable app that posts its location on every open
// would otherwise generate a request per launch for a user who never moves.
const geocodeCacheSchema = new mongoose.Schema(
  {
    // "<lat>,<lng>" rounded to GEO_KEY_DECIMALS - see utils/reverseGeocode.js.
    key: { type: String, required: true, unique: true, index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    // Short human label shown in the admin UI, e.g. "Banjara Hills, Hyderabad".
    address: { type: String, default: null },
    // Full upstream string, kept for support/debugging - never shown in tables.
    displayName: { type: String, default: null },
    components: { type: mongoose.Schema.Types.Mixed, default: null },
    provider: { type: String, default: null },
    // 'ok'        - upstream resolved these coordinates
    // 'not_found' - upstream answered but has no place here (mid-ocean, etc.)
    status: { type: String, enum: ['ok', 'not_found'], default: 'ok' },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Entries expire so that renamed roads and reorganised localities eventually
// refresh themselves. TTL is applied by Mongo against expiresAt.
geocodeCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
geocodeCacheSchema.add({ expiresAt: { type: Date, default: null } });

module.exports = mongoose.model('GeocodeCache', geocodeCacheSchema);

/**
 * Unit tests for turning device coordinates into place names.
 *
 * These cover the pure parts - cache keying, label construction from each
 * provider's response shape, and coordinate validation. The network and the
 * Mongo cache are not exercised here; those are integration concerns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cacheKey,
  isValidCoord,
  buildLabel,
  labelFromNominatim,
  labelFromGoogle,
  GEO_KEY_DECIMALS,
} = require('../src/utils/reverseGeocode');

// --- cache keying ----------------------------------------------------------

test('coordinates are keyed at about 11 m so GPS jitter reuses one lookup', () => {
  assert.equal(GEO_KEY_DECIMALS, 4);
  // Three readings from the same spot, differing below the key resolution.
  const a = cacheKey(17.4351, 78.452);
  const b = cacheKey(17.435102, 78.4520411);
  const c = cacheKey(17.43509, 78.45204);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a, '17.4351,78.452');
});

test('a move of more than the key resolution produces a different key', () => {
  assert.notEqual(cacheKey(17.4351, 78.452), cacheKey(17.4451, 78.452));
});

test('string coordinates key the same as numeric ones', () => {
  assert.equal(cacheKey('17.4351', '78.4520'), cacheKey(17.4351, 78.452));
});

test('negative zero does not create a second key for the same point', () => {
  assert.equal(cacheKey(-0, -0), cacheKey(0, 0));
});

// --- validation ------------------------------------------------------------

test('coordinates outside the valid range are rejected', () => {
  assert.equal(isValidCoord(17.4351, 78.452), true);
  assert.equal(isValidCoord(-90, -180), true);
  assert.equal(isValidCoord(90, 180), true);
  assert.equal(isValidCoord(91, 0), false);
  assert.equal(isValidCoord(0, 181), false);
  assert.equal(isValidCoord(null, 78.452), false);
  assert.equal(isValidCoord(undefined, undefined), false);
  assert.equal(isValidCoord(NaN, 0), false);
  assert.equal(isValidCoord('not a number', 0), false);
});

test('0,0 is a valid coordinate even though it is mid-ocean', () => {
  // Validity is a range check. Whether a place exists there is the provider's
  // answer, and it is allowed to say no.
  assert.equal(isValidCoord(0, 0), true);
});

// --- label construction ----------------------------------------------------

test('locality and city make the label', () => {
  assert.equal(
    labelFromNominatim({
      neighbourhood: 'Banjara Hills',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
    }),
    'Banjara Hills, Hyderabad'
  );
});

test('an administrative ward number is stripped from the locality', () => {
  assert.equal(
    labelFromNominatim({
      suburb: 'Ward 97 Somajiguda',
      city: 'Hyderabad',
      state: 'Telangana',
      country: 'India',
    }),
    'Somajiguda, Hyderabad'
  );
  assert.equal(
    labelFromNominatim({
      suburb: 'Ward No. 12 Adyar',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
    }),
    'Adyar, Chennai'
  );
});

test('a locality that is only a number is left intact', () => {
  // "Sector 17" in Chandigarh is the actual name of the place; stripping the
  // number would leave nothing.
  assert.equal(
    labelFromNominatim({
      suburb: 'Sector 17',
      city: 'Chandigarh',
      state: 'Chandigarh',
      country: 'India',
    }),
    'Sector 17, Chandigarh'
  );
});

test('a repeated name is not printed twice', () => {
  // Upstream frequently reports suburb == city. "Hyderabad, Hyderabad" is
  // wrong-looking, and a bare "Hyderabad" is too vague, so fall through to
  // city + region.
  const label = labelFromNominatim({
    suburb: 'Hyderabad',
    city: 'Hyderabad',
    state: 'Telangana',
    country: 'India',
  });
  assert.equal(label, 'Hyderabad, Telangana');
});

test('the country is only added when there is no city to anchor the label', () => {
  // "Mumbai, Maharashtra, India" is needlessly long for a table column, but a
  // bare "Telangana" is too vague to be useful.
  assert.equal(
    labelFromNominatim({ city: 'Mumbai', state: 'Maharashtra', country: 'India' }),
    'Mumbai, Maharashtra'
  );
  assert.equal(labelFromNominatim({ state: 'Telangana', country: 'India' }), 'Telangana, India');
});

test('a sparse response falls back to region and country', () => {
  assert.equal(
    labelFromNominatim({ state: 'Telangana', country: 'India' }),
    'Telangana, India'
  );
  assert.equal(labelFromNominatim({ country: 'India' }), 'India');
});

test('an empty or missing address yields no label, not an empty string', () => {
  assert.equal(labelFromNominatim(null), null);
  assert.equal(labelFromNominatim(undefined), null);
  assert.equal(labelFromNominatim({}), null);
});

test('a label never exceeds the 500-char schema limit', () => {
  const long = 'x'.repeat(400);
  const label = buildLabel([long, long + 'y', long + 'z']);
  assert.ok(label.length <= 500, `label was ${label.length} chars`);
});

test('blank and whitespace-only parts are dropped', () => {
  assert.equal(buildLabel([null, '  ', 'Hyderabad', '']), 'Hyderabad');
  assert.equal(buildLabel([null, undefined, '']), null);
});

// --- Google response shape -------------------------------------------------

const googleResult = (components, formatted) => ({
  address_components: components,
  formatted_address: formatted,
});

test('the Google response shape produces the same style of label', () => {
  const label = labelFromGoogle(
    googleResult(
      [
        { long_name: 'Banjara Hills', types: ['sublocality', 'sublocality_level_1'] },
        { long_name: 'Hyderabad', types: ['locality'] },
        { long_name: 'Telangana', types: ['administrative_area_level_1'] },
        { long_name: 'India', types: ['country'] },
      ],
      'Banjara Hills, Hyderabad, Telangana 500034, India'
    )
  );
  assert.equal(label, 'Banjara Hills, Hyderabad');
});

test('Google components with no locality widen to region', () => {
  const label = labelFromGoogle(
    googleResult(
      [
        { long_name: 'Telangana', types: ['administrative_area_level_1'] },
        { long_name: 'India', types: ['country'] },
      ],
      'Telangana, India'
    )
  );
  assert.equal(label, 'Telangana, India');
});

test('a Google result with no usable components falls back to formatted_address', () => {
  const label = labelFromGoogle(googleResult([], 'Somewhere, Nowhere'));
  assert.equal(label, 'Somewhere, Nowhere');
});

test('a malformed Google result does not throw', () => {
  assert.equal(labelFromGoogle(null), null);
  assert.equal(labelFromGoogle({}), null);
  assert.equal(labelFromGoogle({ address_components: null }), null);
  // A component missing its types array must be skipped, not crash.
  assert.equal(labelFromGoogle({ address_components: [{ long_name: 'X' }] }), null);
});

test('an unset coordinate is not silently treated as the equator', () => {
  // Regression: Number(null), Number('') and Number(false) are all 0, so a
  // loose check would geocode 0,0 for every user with no location stored.
  assert.equal(isValidCoord(null, null), false);
  assert.equal(isValidCoord('', ''), false);
  assert.equal(isValidCoord(false, false), false);
  assert.equal(isValidCoord([], []), false);
  assert.equal(isValidCoord(null, 78.452), false);
  assert.equal(isValidCoord(17.4351, null), false);
});

test('a locality that is only an administrative designator is skipped', () => {
  // "L Ward" names a Mumbai council district, not a place a person would
  // recognise; the label should fall through to the city and region.
  assert.equal(
    labelFromNominatim({
      suburb: 'L Ward',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
    }),
    'Mumbai, Maharashtra'
  );
  assert.equal(
    labelFromNominatim({
      suburb: 'Ward 12',
      city: 'Pune',
      state: 'Maharashtra',
      country: 'India',
    }),
    'Pune, Maharashtra'
  );
});

test('a real place name that merely contains a designator word is kept', () => {
  // Guard against the admin filter being too eager.
  assert.equal(
    labelFromNominatim({
      suburb: 'Ward Hill',
      city: 'Salem',
      state: 'Massachusetts',
      country: 'United States',
    }),
    'Ward Hill, Salem'
  );
  assert.equal(
    labelFromNominatim({
      suburb: 'Block Island',
      city: 'New Shoreham',
      state: 'Rhode Island',
      country: 'United States',
    }),
    'Block Island, New Shoreham'
  );
});

test('a trailing administrative designator is skipped too', () => {
  // Nominatim returns "Mumbai Zone 5" as the suburb for parts of Mumbai. It is
  // a municipal zone, not a neighbourhood, so it must not become the label.
  assert.equal(
    labelFromNominatim({
      suburb: 'Mumbai Zone 5',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
    }),
    'Mumbai, Maharashtra'
  );
  assert.equal(
    labelFromNominatim({
      suburb: 'Ward No. 12',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
    }),
    'Chennai, Tamil Nadu'
  );
});

test('"sector" is never treated as administrative bookkeeping', () => {
  // Sector numbers are the real, everyday names of places in Chandigarh, Noida
  // and Gurugram. Dropping them would lose the only useful part of the label.
  assert.equal(
    labelFromNominatim({
      suburb: 'Sector 17',
      city: 'Chandigarh',
      state: 'Chandigarh',
      country: 'India',
    }),
    'Sector 17, Chandigarh'
  );
  assert.equal(
    labelFromNominatim({
      neighbourhood: 'Sector 62',
      city: 'Noida',
      state: 'Uttar Pradesh',
      country: 'India',
    }),
    'Sector 62, Noida'
  );
});

test('the Google path applies the same administrative filtering', () => {
  const label = labelFromGoogle({
    address_components: [
      { long_name: 'L Ward', types: ['sublocality'] },
      { long_name: 'Mumbai', types: ['locality'] },
      { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
      { long_name: 'India', types: ['country'] },
    ],
    formatted_address: 'L Ward, Mumbai, Maharashtra, India',
  });
  assert.equal(label, 'Mumbai, Maharashtra');
});

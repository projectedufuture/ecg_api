const { Parser } = require('json2csv');

function exportToCSV(data, fields) {
  const parser = new Parser({ fields });
  return parser.parse(data);
}

const userFields = [
  { label: 'ID', value: 'id' },
  { label: 'Name', value: 'name' },
  { label: 'Email', value: 'email' },
  { label: 'Registered Date', value: 'registeredDate' },
  { label: 'Last Active', value: 'lastActive' },
  { label: 'Status', value: 'status' },
  { label: 'Device ID', value: 'deviceId' },
  { label: 'Sessions', value: 'sessions' },
];

const deviceFields = [
  { label: 'Device ID', value: 'id' },
  { label: 'User ID', value: 'userId' },
  { label: 'User Name', value: 'userName' },
  { label: 'Last Seen', value: 'lastSeen' },
  { label: 'Firmware', value: 'firmware' },
  { label: 'Hardware Version', value: 'hardwareVersion' },
  { label: 'License Status', value: 'licenseStatus' },
  { label: 'Battery Level', value: 'batteryLevel' },
];

const licenseFields = [
  { label: 'License ID', value: 'id' },
  { label: 'License Key', value: 'licenseKey' },
  { label: 'Device ID', value: 'deviceId' },
  { label: 'Client ID', value: 'clientId' },
  { label: 'Status', value: 'status' },
  { label: 'Activation Date', value: 'activationDate' },
  { label: 'Expiry Date', value: 'expiryDate' },
];

const sessionFields = [
  { label: 'Session ID', value: 'id' },
  { label: 'User ID', value: 'userId' },
  { label: 'User Email', value: 'userEmail' },
  { label: 'User Name', value: 'userName' },
  { label: 'Device ID', value: 'deviceId' },
  { label: 'Start Time', value: 'startTime' },
  { label: 'End Time', value: 'endTime' },
  { label: 'Duration (min)', value: 'duration' },
  { label: 'Data Points', value: 'dataPoints' },
  { label: 'Data Source', value: 'dataSource' },
  { label: 'Avg Temp (°C)', value: 'avgTemp' },
  { label: 'Avg HR', value: 'avgHR' },
  { label: 'Min HR', value: 'minHR' },
  { label: 'Max HR', value: 'maxHR' },
];

module.exports = {
  exportToCSV,
  userFields,
  deviceFields,
  licenseFields,
  sessionFields,
};


require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: "test",
    serverSelectionTimeoutMS: 15000,
  });

  const db = mongoose.connection.db;
  console.log("\nConnected database:", db.databaseName);
  console.log("\nCollection document counts:");

  const collections = await db.listCollections().toArray();

  for (const collection of collections) {
    const count = await db
      .collection(collection.name)
      .countDocuments({});

    console.log(`${collection.name}: ${count}`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("Error:", error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});


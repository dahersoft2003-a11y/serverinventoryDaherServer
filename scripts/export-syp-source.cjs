const fs = require("node:fs");
const path = require("node:path");
const { get, ref, goOffline } = require("firebase/database");
require("dotenv").config({ quiet: true });
const { database } = require("../dist/firebaseConfig");

async function main() {
  const destination = process.argv[2];
  if (!destination) throw new Error("Pass a new local backup file path.");
  if (fs.existsSync(destination)) throw new Error("Backup file already exists.");
  let timeout;
  try {
    const snapshot = await Promise.race([
      get(ref(database)),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Database read timed out.")),
          20000,
        );
      }),
    ]);
    if (!snapshot.exists()) throw new Error("Database is empty; no backup written.");
    const data = snapshot.val();
    fs.writeFileSync(path.resolve(destination), JSON.stringify(data, null, 2), {
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        file: path.resolve(destination),
        collections: Object.fromEntries(
          Object.entries(data)
            .filter(([, v]) => v && typeof v === "object")
            .map(([k, v]) => [k, Object.keys(v).length]),
        ),
      }),
    );
  } finally {
    clearTimeout(timeout);
    goOffline(database);
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

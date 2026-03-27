import Redis from "ioredis";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

async function test() {
  try {
    // Check if konoha:bus stream exists and what's in it
    console.log("Checking konoha:bus stream...");
    const busLen = await redis.xlen("konoha:bus");
    console.log("Messages in konoha:bus:", busLen);

    if (busLen > 0) {
      const recent = await redis.xrevrange("konoha:bus", "+", "-", "COUNT", 3);
      console.log("\nLast 3 messages in bus:");
      for (const msg of recent) {
        const [id, fields] = msg;
        const obj: any = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        console.log(`  [${id}]`, obj);
      }
    }

    // Check Shino's agent stream
    console.log("\n\nChecking konoha:agent:shino stream...");
    const shinoLen = await redis.xlen("konoha:agent:shino");
    console.log("Messages in shino's inbox:", shinoLen);

    if (shinoLen > 0) {
      const recent = await redis.xrevrange("konoha:agent:shino", "+", "-", "COUNT", 3);
      console.log("\nLast 3 messages for shino:");
      for (const msg of recent) {
        const [id, fields] = msg;
        const obj: any = {};
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        console.log(`  [${id}]`, obj);
      }
    }

  } finally {
    await redis.disconnect();
  }
}

test();

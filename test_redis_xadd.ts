import Redis from "ioredis";

const redis = new Redis({ host: "127.0.0.1", port: 6379 });

async function test() {
  try {
    console.log("Test 1: Normal xadd");
    const id1 = await redis.xadd("test:stream", "*", "field1", "value1");
    console.log("Result:", id1, "Type:", typeof id1);

    console.log("\nTest 2: Another xadd on same stream");
    const id2 = await redis.xadd("test:stream", "*", "field2", "value2");
    console.log("Result:", id2, "Type:", typeof id2);

    console.log("\nTest 3: Read stream");
    const messages = await redis.xread("COUNT", 2, "STREAMS", "test:stream", "0");
    console.log("Messages:", messages);

    // Cleanup
    await redis.del("test:stream");
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await redis.disconnect();
  }
}

test();

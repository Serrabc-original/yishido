process.argv[2] = process.argv[2] || "test/fixtures/woztell-invalid-image.json";
await import("./simulate-media-intake.js");

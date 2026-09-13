const frame = (kind, value = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5); header[0] = kind; header.writeUInt32LE(value.length, 1);
  process.stdout.write(Buffer.concat([header, value]));
};
frame(1, Buffer.from(process.argv[2] === "voice_3" ? "wrong-version" : "1|sherpa-onnx-1.13.8|kokoro-1.0|24000"));
let input = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 6 && input.length >= input.readUInt32LE(0) + 6) {
    const size = input.readUInt32LE(0);
    const text = input.subarray(6, size + 6).toString();
    input = input.subarray(size + 6);
    if (text === "wait") continue;
    if (text === "crash") process.exit(3);
    frame(2, Buffer.from([0, 0, 1, 0])); frame(3);
  }
});

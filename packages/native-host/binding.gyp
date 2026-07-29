{
  "targets": [
    {
      "target_name": "ponderosa_native",
      "sources": ["src/native.cc"],
      "conditions": [
        ["OS=='win'", {
          "defines": ["UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN"]
        }]
      ]
    }
  ]
}

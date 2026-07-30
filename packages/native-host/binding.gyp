{
  "targets": [
    {
      "target_name": "ponderosa_native",
      "sources": ["src/native.cc"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "MACOSX_DEPLOYMENT_TARGET": "14.0"
          }
        }],
        ["OS=='win'", {
          "defines": [
            "UNICODE",
            "_UNICODE",
            "WIN32_LEAN_AND_MEAN",
            "_WIN32_WINNT=0x0A00"
          ]
        }]
      ]
    }
  ]
}

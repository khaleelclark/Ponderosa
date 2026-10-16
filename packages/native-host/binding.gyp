{
  "targets": [
    {
      "target_name": "ponderosa_native",
      "sources": [
        "src/native.cc"
      ],
      "conditions": [
        [
          "OS=='mac'",
          {
            "xcode_settings": {
              "MACOSX_DEPLOYMENT_TARGET": "14.0",
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
            }
          }
        ],
        [
          "OS=='win'",
          {
            "defines": [
              "UNICODE",
              "_UNICODE",
              "WIN32_LEAN_AND_MEAN",
              "_WIN32_WINNT=0x0A00"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1
              }
            }
          }
        ]
      ],
      "include_dirs": [
        "<!(node sqlite-headers.cjs)"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ]
    }
  ]
}

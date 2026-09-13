// Private Ponderosa speech protocol 1. All paths/voice choices come from the
// supervisor, never from a public request. Input text is carried on stdin.
#include "sherpa-onnx/c-api/c-api.h"
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#ifdef __linux__
#include <sys/resource.h>
#endif
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
static bool write_frame(uint8_t type,const void* data,uint32_t size) {
  uint8_t header[5]={type,uint8_t(size),uint8_t(size>>8),uint8_t(size>>16),uint8_t(size>>24)};
  return fwrite(header,1,5,stdout)==5 && (!size||fwrite(data,1,size,stdout)==size) && fflush(stdout)==0;
}
static int32_t audio(const float* samples,int32_t n,float,void* arg) {
  auto* total=static_cast<uint32_t*>(arg);
  if(n<0 || uint64_t(*total)+uint64_t(n)*2>2880000) return 0;
  *total+=uint32_t(n)*2;
  std::vector<uint8_t> pcm(size_t(n)*2);
  for(int32_t i=0;i<n;++i){const int16_t v=static_cast<int16_t>(std::clamp(samples[i],-1.0f,1.0f)*32767);pcm[i*2]=uint8_t(v);pcm[i*2+1]=uint8_t(uint16_t(v)>>8);}
  return write_frame(2,pcm.data(),uint32_t(pcm.size()))?1:0;
}
int main(int argc,char**argv) {
  if(argc!=3)return 2;
#ifdef __linux__
  // Limit native allocations and disable core dumps containing message text.
  const rlimit memory{2ULL*1024*1024*1024,2ULL*1024*1024*1024};
  const rlimit core{0,0};
  if(setrlimit(RLIMIT_AS,&memory)!=0||setrlimit(RLIMIT_CORE,&core)!=0)return 3;
#endif
#ifdef _WIN32
  _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
  if(!freopen("NUL","w",stderr))return 3;
#else
  if(!freopen("/dev/null","w",stderr))return 3;
#endif
  const std::string root=argv[1],voice=argv[2];
  const int sid=voice=="voice_1"?3:voice=="voice_2"?16:voice=="voice_3"?21:-1;
  if(sid<0)return 2;
  const std::string model=root+"/model.onnx",voices=root+"/voices.bin",tokens=root+"/tokens.txt",data=root+"/espeak-ng-data",lex=root+(sid==21?"/lexicon-gb-en.txt":"/lexicon-us-en.txt");
  SherpaOnnxOfflineTtsConfig cfg{};
  cfg.model.kokoro.model=model.c_str();cfg.model.kokoro.voices=voices.c_str();cfg.model.kokoro.tokens=tokens.c_str();cfg.model.kokoro.data_dir=data.c_str();cfg.model.kokoro.lexicon=lex.c_str();cfg.model.kokoro.length_scale=1;cfg.model.num_threads=2;cfg.model.provider="cpu";cfg.max_num_sentences=1;
  const auto* tts=SherpaOnnxCreateOfflineTts(&cfg);
  if(!tts)return 3;
  if(SherpaOnnxOfflineTtsSampleRate(tts)!=24000)return 3;
  constexpr char ready[]="1|sherpa-onnx-1.13.8|kokoro-1.0|24000";
  if(!write_frame(1,ready,sizeof(ready)-1))return 4;
  uint8_t header[6];
  while(fread(header,1,6,stdin)==6){
    const uint32_t size=uint32_t(header[0])|(uint32_t(header[1])<<8)|(uint32_t(header[2])<<16)|(uint32_t(header[3])<<24);
    const uint16_t speed=uint16_t(header[4])|(uint16_t(header[5])<<8);
    if(size==0||size>800||speed<75||speed>125)break;
    std::string text(size,'\0');if(fread(text.data(),1,size,stdin)!=size||text.find('\0')!=std::string::npos)break;
    SherpaOnnxGenerationConfig generation{};generation.sid=sid;generation.speed=float(speed)/100;generation.silence_scale=.2;
    uint32_t total=0;
    const auto* result=SherpaOnnxOfflineTtsGenerateWithConfig(tts,text.c_str(),&generation,audio,&total);
    const bool ok=result && result->n>0 && uint64_t(result->n)*2<=2880000;
    if(result)SherpaOnnxDestroyOfflineTtsGeneratedAudio(result);
    if(!write_frame(ok?3:4,nullptr,0))break;
  }
  SherpaOnnxDestroyOfflineTts(tts);
}

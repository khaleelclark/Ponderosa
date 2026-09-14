/* Synthetic test image only. Build against libheif; no external photo rights. */
#include <libheif/heif.h>
#include <stdio.h>
#include <stdlib.h>
static void check(struct heif_error error) {
  if(error.code != heif_error_Ok) { fprintf(stderr,"%s\n",error.message); exit(1); }
}
int main(int argc,char **argv) {
  if(argc != 3) return 1;
  struct heif_context *context=heif_context_alloc();
  struct heif_encoder *encoder=NULL;
  struct heif_image *image=NULL;
  struct heif_image_handle *handle=NULL;
  check(heif_context_get_encoder_for_format(context,heif_compression_HEVC,&encoder));
  check(heif_encoder_set_lossy_quality(encoder,95));
  check(heif_encoder_set_parameter(encoder,"x265:pools","1"));
  check(heif_image_create(64,48,heif_colorspace_RGB,heif_chroma_interleaved_RGB,&image));
  check(heif_image_add_plane(image,heif_channel_interleaved,64,48,8));
  int stride;
  unsigned char *data=heif_image_get_plane(image,heif_channel_interleaved,&stride);
  for(int y=0;y<48;y++)for(int x=0;x<64;x++){
    unsigned char *p=data+y*stride+x*3;
    p[0]=x<32?255:0;p[1]=y<24?255:0;p[2]=x>=32?255:0;
  }
  struct heif_encoding_options *options=heif_encoding_options_alloc();
  options->image_orientation=atoi(argv[2]);
  check(heif_context_encode_image(context,image,encoder,options,&handle));
  check(heif_context_write_to_file(context,argv[1]));
  heif_encoding_options_free(options);heif_image_handle_release(handle);
  heif_image_release(image);heif_encoder_release(encoder);heif_context_free(context);
  return 0;
}

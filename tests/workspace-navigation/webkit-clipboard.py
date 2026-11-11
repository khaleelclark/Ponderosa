# Existing GTK3 owns the real X clipboard while WebDriver issues Control+V.
import ctypes,sys
text=sys.stdin.buffer.read();gtk=ctypes.CDLL('libgtk-3.so.0');gdk=ctypes.CDLL('libgdk-3.so.0')
gtk.gtk_init_check.argtypes=[ctypes.c_void_p,ctypes.c_void_p];gtk.gtk_init_check.restype=ctypes.c_int
assert gtk.gtk_init_check(None,None),'GTK clipboard initialization'
gdk.gdk_atom_intern.argtypes=[ctypes.c_char_p,ctypes.c_int];gdk.gdk_atom_intern.restype=ctypes.c_void_p
gtk.gtk_clipboard_get.argtypes=[ctypes.c_void_p];gtk.gtk_clipboard_get.restype=ctypes.c_void_p
gtk.gtk_clipboard_set_text.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_int]
clipboard=gtk.gtk_clipboard_get(gdk.gdk_atom_intern(b'CLIPBOARD',False));gtk.gtk_clipboard_set_text(clipboard,text,len(text));print('READY',flush=True);gtk.gtk_main()

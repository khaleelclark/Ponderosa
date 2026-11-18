# Held storage capacity observations

The export cache may query current caller-available capacity only through its
still-held directory or exact registered portable data-root authority. Linux
uses fstatvfs on a supplied directory descriptor and checks expected device and
inode around the observation. macOS uses fstatfs on the registered root's held
directory descriptor. Windows uses NtQueryVolumeInformationFile on the retained
directory handle with FileFsFullSizeInformation and caller-available units; no
path is reconstructed for the query. Values are exact unsigned byte counts,
with overflow and unsupported volumes refused.

The result is an instant observation, not a reservation or a guarantee against
other writers consuming space. Callers must preserve their headroom policy and
handle storage errors after admission. A closed, replaced, unregistered or
non-root authority is refused. No file, mount or directory is modified.

Sources: Apple's fstatfs(2) manual, Microsoft's NtQueryVolumeInformationFile and
FILE_FS_FULL_SIZE_INFORMATION documentation. Native regression uses only owned
disposable folders. Windows still needs execution on a real Windows host.

Pool accounting can also observe allocation on a retained regular file descriptor.
Linux and macOS report st_blocks in 512-byte units; Windows reads AllocationSize
with GetFileInformationByHandleEx(FileStandardInfo). Callers must validate file
membership and serialize operations around the observation; it is not a space
reservation and concurrent writers may change allocation immediately afterward.

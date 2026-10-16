# AppImage sandbox setup

Open the AppImage as your normal user. On Ubuntu hosts that restrict unprivileged
user namespaces, the first launch requests administrator approval through the
system authentication dialog to install Ponderosa's AppArmor profile. Engine
then runs as your normal user with its renderer sandbox enabled.

If the host has no PolicyKit authentication service, run the setup explicitly:

```sh
sudo ./Ponderosa-1.0.0-beta.1-linux-x64.AppImage --install-sandbox
./Ponderosa-1.0.0-beta.1-linux-x64.AppImage
```

Use the actual downloaded filename. Setup accepts no other arguments and never
starts Engine as root. Cancelling authentication leaves Engine unopened.

The root-owned `/etc/apparmor.d/ponderosa-appimage` profile grants `userns` only
to the Ponderosa Electron executable inside AppImage FUSE mount paths. Its stable
name covers later AppImage versions. It does not turn off global AppArmor
restrictions or add a `--no-sandbox` flag. An existing different profile is
preserved and reported rather than overwritten.

Removing an AppImage file preserves saved data. The small system profile can
remain for a later version. To remove that integration too, an administrator can
unload it with `sudo apparmor_parser --remove /etc/apparmor.d/ponderosa-appimage`
and then remove that exact profile file. This does not remove Ponderosa data.

<div align="center">

<img src="https://termix.site/img/logo.svg" width="120" alt="Termix Logo" />

<h1>Backups</h1>

<p>Back up folders, databases and Docker data on your hosts with restic, then browse, download and restore</p>

<!-- VIDEO:START -->

<a href="https://www.youtube.com/watch?v=iYSNUgwpH_0"><img src="https://img.shields.io/badge/Watch_the_demo-f59145?style=for-the-badge&logo=youtube&logoColor=white" alt="Watch the demo on YouTube" /></a>

<!-- VIDEO:END -->

</div>

<br />

## Overview

Backups keeps encrypted copies of the data on your hosts. Termix runs restic on each host on a schedule, watches every run and lets you browse, download and restore from any snapshot.

Read the [docs](https://docs.termix.site/plugins/backups) to set it up and use it.

<br />

## Features

- Encrypted, deduplicated backups with restic, installed for you when a host has none
- Store backups in S3 compatible storage, a restic REST server, any rclone remote or a folder on the host
- Back up folders, MySQL, MariaDB, PostgreSQL and SQLite databases, and Docker volumes and stacks
- Run backups on a schedule, with commands before and after and old snapshots removed for you
- Backups run on the host by themselves, so they carry on if Termix restarts
- Watch a backup run live, stop it, and read its log
- Browse snapshots, download a file or a folder, and restore to the same host or another one
- Get an alert when a backup fails or none has worked for a few days
- A dashboard card with the state of every backup job
- Termix actions to list jobs and snapshots, and to start or stop a backup

<br />

## Sponsors

For a paid sponsor spot, email [mail@termix.site](mailto:mail@termix.site).

<!-- SPONSORS:START -->

<div align="center">

<br />

<a href="https://www.blacksmith.sh/">
  <img src="https://termix.site/img/sponsors/blacksmith.svg" height="40" alt="Blacksmith" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.cloudflare.com/">
  <img src="https://termix.site/img/sponsors/cloudflare.png" height="40" alt="Cloudflare" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://akamai.com/">
  <img src="https://termix.site/img/sponsors/akamai.svg" height="40" alt="Akamai" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://aws.amazon.com/">
  <img src="https://termix.site/img/sponsors/aws.png" height="40" alt="AWS" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://rackgenius.com/">
  <img src="https://termix.site/img/sponsors/rackgenius.png" height="40" alt="Rack Genius" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://ginernet.com/">
  <img src="https://termix.site/img/sponsors/ginernet.png" height="40" alt="Ginernet" />
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://www.hetzner.com/?mtm_campaign=termix&mtm_medium=referral&mtm_content=sponsoring_link">
  <img src="https://termix.site/img/sponsors/hetzner.png" height="40" alt="Hetzner" />
</a>

</div>

<!-- SPONSORS:END -->

<br />

## Support

Bugs and ideas for Backups go in this repo: [report a bug](https://github.com/Termix-SSH/Plugin-Backups/issues/new?template=bug_report.yml) or [request a feature](https://github.com/Termix-SSH/Plugin-Backups/issues/new?template=feature_request.yml). Report an issue on the plugin's page in the Plugins tab fills in your versions for you.

Problems with Termix itself (login, hosts, credentials, sharing, sync) go in the [Termix repo](https://github.com/Termix-SSH/Termix/issues/new/choose). Not sure where it goes? Open it there and it will be moved.

Add as much detail as you can, in English if possible. For questions, join the [Discord](https://discord.gg/jVQGdvHDrf) server.

<br />

## License

Apache License 2.0. See [LICENSE](LICENSE).

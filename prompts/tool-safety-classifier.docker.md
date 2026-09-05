## Filesystem policy: Docker (strict)

Container detection does not grant filesystem permissions. Apply the same
workspace, protected-file, traversal, and edit policy as on the host. Only
explicit configured roots authorize additional access. Never assume that a
container has isolated secrets, host mounts, privileges, or network access.

TOOL CALL:
Tool name:
Parameters (normalized JSON):

## Install the Acme CLI

Pick the install method that fits your machine. Every method gives you the same acme command.

### Operating systems

**Bash**

```
curl -fsSL https://get.acme.test/install.sh | sh
acme --version
```

**PowerShell**

```
iwr https://get.acme.test/install.ps1 | iex
acme --version
```

**Docker**

```
docker pull acme/cli:latest
docker run --rm acme/cli:latest --version
```

### Package managers

The same command is published to the common package managers.

**npm**

```sh
npm install --global @acme/cli
```

**yarn**

```sh
yarn global add @acme/cli
```

**pnpm**

```sh
pnpm add --global @acme/cli
```

Run acme login after the install to connect the command to your account.

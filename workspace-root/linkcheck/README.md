# linkcheck

linkcheck is a tool that scans markdown files in a given directory and checks both HTTP and local links for validity. It helps ensure that all links in your markdown documentation are working and up to date.

## Usage

You can run linkcheck either by using the shell wrapper or directly with Node.js:

### Using the shell wrapper

```bash
sh linkcheck.sh <dir>
```

Make sure the `linkcheck.sh` script is executable.

### Using Node.js directly

```bash
node bin/linkcheck.js <dir>
```

Replace `<dir>` with the path to the directory you want to scan.

## Exit Code

- Returns exit code 1 if broken links are found.
- Returns exit code 0 if all links are valid.

## Tests

To run tests for linkcheck, use:

```bash
npm test
```

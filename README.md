# Node Fetcher [ ![Codeship Status for denizozger/node-fetcher](https://www.codeship.io/projects/09cdfe10-2e0f-0131-709f-26f2c1e2a692/status?branch=master)](https://www.codeship.io/projects/9380)

This Node application receives some data requests from another server, periodically checks an API for new data, and as new data is received, publishes it to requesting server.

# Running Locally

``` bash
npm install
foreman start
```

## How it works

Some code that connects to an API runs in an infinite loop.

1. Listens to HTTP GETs to /fetchlist/new/some-key.
2. Adds some-key to key list on memory
3. The periodic job goes over key list, and requests JSON data from another API (ie. http://data-provider/some-key)
4. If there is version information, checks the version to determine if data is new
5. If "terminated" flag is on, removes some-key from the key list
6. Transmits new data to the server which issued HTTP GET /fetchlist/new/some-key on step 1

![Schema](http://i39.tinypic.com/2hnrght.png)

Please see [node-websocket](https://github.com/denizozger/node-websocket) and [node-dataprovider](https://github.com/denizozger/node-dataprovider) implementations too. You can either set these up on your local, or use the deployed apps running on Heroku. See project homepages for Heroku URLs.

If you setup the other three projects, you should start node-fetcher as:

``` bash
PORT=4000 DATA_REQUESTING_SERVER_URL=http://localhost:5000/broadcast/ DATA_PROVIDER_HOST=localhost DATA_PROVIDER_PORT=3000 foreman start
```

[![Bitdeli Badge](https://d2weczhvl823v0.cloudfront.net/denizozger/node-fetcher/trend.png)](https://bitdeli.com/free "Bitdeli Badge")


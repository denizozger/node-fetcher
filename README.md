# Node Fetcher 

This Node application receives some data requests from another server, periodically checks an API for new data, and as new data is received, publishes it to requesting server.

# Running Locally

``` bash
npm install
node --harmony start
```

## How it works

Please see [node-socketio](https://github.com/denizozger/node-socketio) and [node-dataprovider](https://github.com/denizozger/node-dataprovider) implementations too, all three applications work together - although not necessarily.

1. Subscribes to a publisher ([node-socketio](https://github.com/denizozger/node-socketio)), listening for requests
2. Pushes the new request into an IPC loop between master process and workers.
3. Worker pulls the request
4. Worker makes an HTTP GET request to an API providing data in JSON ([node-dataprovider](https://github.com/denizozger/node-dataprovider))
5. When the worker receives HTTP response, it pushes the data to master process via a different IPC
6. Master pulls the data and publishes it to a web socket server ([node-socketio](https://github.com/denizozger/node-socketio)), and decides to keep the resouce in the loop or not

When you have all three applications, you should start node-fetcher as:

``` bash
PORT=4000 DATA_PROVIDER_HOST=localhost DATA_PROVIDER_PORT=3000 node --harmony server.js
```

[![Bitdeli Badge](https://d2weczhvl823v0.cloudfront.net/denizozger/node-fetcher/trend.png)](https://bitdeli.com/free "Bitdeli Badge")

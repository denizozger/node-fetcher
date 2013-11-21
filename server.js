var express = require('express');
var app = express();
var http = require('http');
var async = require('async');
var _ = require('underscore');
var request = require('request');

app.use(express.logger());

var port = process.env.PORT || 5000;

app.listen(port, function() {
  console.log('Server listening on %s', port);
});

var resourcesAndVersions = {};
const resourceDefaultVersion = -1;
const dataRequestingServerURL = process.env.DATA_REQUESTING_SERVER_URL || 'http://node-websocket-server.herokuapp.com/broadcast/';
const dataProviderHost = process.env.DATA_PROVIDER_HOST || 'node-dataprovider.herokuapp.com';
const dataProviderPort = process.env.DATA_PROVIDER_PORT || 80;
const fetchingJobTimeoutInMilis = 5000;
var allDataFetched = true;
const authorizationHeaderKey = 'bm9kZS13ZWJzb2NrZXQ=';
const nodeWebSocketAuthorizationHeaderKey = 'bm9kZS1mZXRjaGVy';

/**
 * The job that fetches data perioducally
 */
var fetchingJob = function () {
  if (allDataFetched) {
    allDataFetched = false;
    fetchData();
  } else {
    console.warn('[NOT READY] Data fetcher is still running, skipping this iteration');
  }  
  setTimeout(fetchingJob, fetchingJobTimeoutInMilis);
};
fetchingJob();

/**
 * Receive data fetch requests
 */
app.get('/fetchlist/new/?*', function(req, res) {
  // Security
  if (req.header('Authorization') !== authorizationHeaderKey) {
    var ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || req.connection.socket.remoteAddress;

    console.warn('Unknown server (%s) tried to add a new key to fetch list', ip);

    res.writeHead(403, {
      'Content-Type': 'text/plain'
    }); 
    res.shouldKeepAlive = false;
    res.write('You are not allowed to get data from this server\n');
    res.end();
    return;
  }

  handleNewDataFetchRequests(req, res);
});

function handleNewDataFetchRequests(req, res) {
  var requestedResourceId = req.params[0];

  if(!requestedResourceId) {
    console.warn('Bad Request: Invalid parameters');
    res.statusCode = 400;
    return res.send('Bad Request');
  }

  if (resourcesAndVersions[requestedResourceId]) {
    console.warn('This resource information is in the fetchlist already. Resource id: %s', requestedResourceId);
    return res.send('This resource information is in the fetchlist already');
  }

  resourcesAndVersions[requestedResourceId] = resourceDefaultVersion;

  console.log('Successfully added resource (id: %s) to the fetchlist. Current fetchlist:', requestedResourceId);
  console.log(JSON.stringify(resourcesAndVersions, null, 4));

  res.send('Success');  
}

app.get('/', function(req, res){
  var body = 'node-fetcher';
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Length', body.length);
  res.end(body);
});

/**
 * Iterate through resources to watch, get new resources & resource data, and broadcast new data if there are any
 */
function fetchData() {
  console.log('[BEGIN] Begin fetching data for %s resources. Timeout is %s miliseconds.', 
    _.size(resourcesAndVersions), fetchingJobTimeoutInMilis);

  var options = {
    host: dataProviderHost,
    port: dataProviderPort,
    method: 'GET'
  };

  // Asynchronously fetch resource data
  async.forEach(_.keys(resourcesAndVersions), function (resourceId, callback) { 
    options.path = '/' + resourceId;

    console.log('Fetching data for resource %s from %s:%s', resourceId, dataProviderHost, dataProviderPort);

    var req = http.get(options, function(res) {
      var updatedResourceInJSON = '';
      res.setEncoding('utf8');

      // Append data as we receive it 
      res.on('data', function (chunk) {
        updatedResourceInJSON += chunk;
        console.log('Received some data from data source: %s', updatedResourceInJSON);
      });

        // When all data is received, check its version and broadcast it if received version is greater
      res.on('end', function() {
          var updatedResource;
          try {
            updatedResource = JSON.parse(updatedResourceInJSON);
          } catch (e) {
            console.error('Did not receive proper JSON object from data provider for resource %s', resourceId);
          }

          var existingVersion = resourcesAndVersions[resourceId];
          var newVersion;

          if (updatedResource) {
            newVersion = updatedResource.version;
          }

          // Compare the existing and new versions, broadcast if necesary
          if (updatedResource) {
            // if there is verson information, compare the versions and broadcast if data is newer
            if (isNumber(existingVersion) && isNumber(newVersion) && newVersion > existingVersion) {
              console.log('Changes detected for resource %s, current version is %s, new version is %s', 
                resourceId, existingVersion, newVersion);  
              broadcastNewResourceData(updatedResource, resourceId);
              resourcesAndVersions[resourceId] = newVersion; // update the version
            } else if (isNumber(existingVersion) && isNumber(newVersion) && newVersion <= existingVersion){
              console.log('No changes detected for resource %s, current version is %s, new version is %s', 
                resourceId, existingVersion, newVersion);  
            } else {
              console.warn('No valid version information detected (current: %s, new: %s), broadcasting the data.',
                existingVersion, newVersion);
              broadcastNewResourceData(updatedResource, resourceId);
            }

            // if the resource is termianted, remove it from the list
            if (updatedResource.terminated === true) {
              console.log('Resource appears to be terminated, removing it from the list');
              delete resourcesAndVersions[resourceId];
            }
          } else {
            console.error('Could not receive new resource data or it was corrupt');
          }

          console.log('All data for resource %s has been received', resourceId);
          callback();
        });

        res.on('error', function(e) {
          console.error('Can not fetch resource data: %s', e.message);
        });
      });
    }, function(err) {
      if (err) {
        console.error('Cant fetch resource data: %s', err);  
      } 
        
      allDataFetched = true; 
      console.log('[COMPLETE] Data fetch is complete');
    }); 
}

// Send new resource data to websocket client - or any other server
function broadcastNewResourceData(updatedResource, resourceId) {
  if (updatedResource && _.isObject(updatedResource)) {
    console.log('Broadcasting new resource data for resource %s', resourceId);

    request({
        uri: dataRequestingServerURL + resourceId + '/?newResourceData=' + JSON.stringify(updatedResource),
        method: 'POST',
        form: {
          newResourceData: JSON.stringify(updatedResource)
        },
        headers: {
          Authorization: nodeWebSocketAuthorizationHeaderKey
        }
      }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
          console.log('Successfully broadcasted resource (id: %s) request message to %s, the response is %s', 
            resourceId, dataRequestingServerURL + resourceId, body); 
        } else {
          console.error('Can not broadcast resource request message to %s: %s', 
            dataRequestingServerURL + resourceId, error);
        }
      });
  } else {
    console.warn('Resource data to broadcast is corrupt: %s', updatedResource);
  }
}

function isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}
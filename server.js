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
const defaultVersion = -1;
var allDataFetched = true;
// const dataRequestingNode = 'http://dry-wildwood-3323.herokuapp.com/broadcast/';
const dataRequestingNode = 'http://localhost:5000/broadcast/';

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
    setTimeout(fetchingJob, 10000);
}
fetchingJob();

/**
 * Receive data fetch requests
 */
 // works: '/:id*' and http://localhost:5000/?/2013/02/16/title-with-hyphens
app.get('/fetchlist/new/?*', function(request, response) {
  var requestedResourceId = request.params[0];

  if(!requestedResourceId) {
    console.warn('Bad Request: Invalid parameters');
    response.statusCode = 400;
    return response.send('Bad Request');
  }

  if (resourcesAndVersions[requestedResourceId]) {
    console.warn('This resource information is in the fetchlist already. Resource id: %s', requestedResourceId);
    return response.send('This resource information is in the fetchlist already');
  }

  resourcesAndVersions[requestedResourceId] = defaultVersion;

  console.log('Successfully added resource (id: %s) to the fetchlist. Current fetchlist:', requestedResourceId);
  console.log(JSON.stringify(resourcesAndVersions, null, 4));

  response.send('Success');
});

/**
 * Iterate through resources to watch, get new resources & resource data, and broadcast new data if there are any
 */
function fetchData() {
  console.log('[BEGIN] Begin fetching data for %s resources', _.size(resourcesAndVersions));

  var options = {
    host: 'nameless-retreat-3788.herokuapp.com',
    port: 80,
    method: 'GET'
  };

  // Asynchronously fetch resource data
  async.forEach(_.keys(resourcesAndVersions), function (resourceId, callback) { 
    var updatedResourceInJSON;

    options.path = '/' + resourceId;

    console.log('Fetching data for resource %s', resourceId);

    var req = http.get(options, function(res) {
      var updatedResourceInJSON = '';
      res.setEncoding('utf8');

      // Append data as we receive it 
      res.on('data', function (chunk) {
        updatedResourceInJSON += chunk;
        console.log('Received some data from data source: %s', updatedResourceInJSON);
      });

      // When all data is received, check its version and broadcast it if received version is greater
      res.on('end', function(){
        var updatedResource;
        try {
          updatedResource = JSON.parse(updatedResourceInJSON);
        } catch (e) {
          console.error('Did not receive proper JSON object from data provider for resource %s', resourceId);
        }

        var existingVersion = resourcesAndVersions[resourceId];
        var newVersion;

        if (updatedResource) {
          newVersion = updatedResource['version'];
        }

        // Compare the existing and new versions
        if (updatedResource && isNumber(existingVersion) && isNumber(newVersion)) {
          console.log('For resource %s, current version is %s, new version is %s', resourceId, existingVersion, newVersion);  

          if (newVersion > existingVersion) {
            broadcastNewResourceData(updatedResource, resourceId);
            resourcesAndVersions[resourceId] = newVersion; // update the version
          } else {
            console.log('No changes detected for resource %s', resourceId)
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
        uri: dataRequestingNode + resourceId,
        method: 'POST',
        form: {
          newResourceData: JSON.stringify(updatedResource)
        }
      }, function(error, response, body) {
        if (!error && response.statusCode == 200) {
          console.log('Successfully broadcasted resource (id: %s) request message to %s, the response is %s', 
            resourceId, dataRequestingNode + resourceId, body); 
        } else {
          console.error('Can not broadcast resource request message to %s: %s', dataRequestingNode + resourceId, error);
        }
      });
  } else {
    console.warn('Resource data to broadcast is corrupt: %s', updatedResource);
  }
}

function isNumber(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
}
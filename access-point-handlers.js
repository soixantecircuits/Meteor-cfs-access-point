getHeaders = [];
getHeadersByCollection = {};

/**
 * @method httpDelHandler
 * @private
 * @returns {any} response
 *
 * HTTP DEL request handler
 */
httpDelHandler = function httpDelHandler(ref) {
  var self = this;
  var opts = FS.Utility.extend({}, self.query || {}, self.params || {});

  // If DELETE request, validate with 'remove' allow/deny, delete the file, and return
  FS.Utility.validateAction(ref.collection.files._validators['remove'], ref.file, self.userId);

  /*
   * From the DELETE spec:
   * A successful response SHOULD be 200 (OK) if the response includes an
   * entity describing the status, 202 (Accepted) if the action has not
   * yet been enacted, or 204 (No Content) if the action has been enacted
   * but the response does not include an entity.
   */
  self.setStatusCode(200);

  return {
    deleted: !!ref.file.remove()
  };
};

/*
  requestRange will parse the range set in request header - if not possible it
  will throw fitting errors and autofill range for both partial and full ranges

  throws error or returns the object:
  {
    start
    end
    length
    unit
    partial
  }
*/
var requestRange = function(req, fileSize) {
  console.log("wouhou");
  if (req) {
    if (req.headers) {
      var rangeString = req.headers.range;

      // Make sure range is a string
      if (rangeString === ''+rangeString) {

        // range will be in the format "bytes=0-32767"
        var parts = rangeString.split('=');
        var unit = parts[0];

        // Make sure parts consists of two strings and range is of type "byte"
        if (parts.length == 2 && unit == 'bytes') {
          // Parse the range
          var end, parts, start;

          parts = req.headers["range"].replace(/bytes=/, "").split("-");
          start = parseInt(parts[0], 10);
          end = (parts[1] ? parseInt(parts[1], 10) : fileSize - 1);

          // Make sure range consists of a start and end point of numbers and start is less than end
          if (start < end) {

            var partSize = (end - start) + 1

            // Return the parsed range
            return {
              start: start,
              end: end,
              length: partSize,
              size: fileSize,
              unit: unit,
              partial: true
            };

          } else {
            throw new Meteor.Error(416, "Requested Range Not Satisfiable");
          }

        } else {
          // The first part should be bytes
          throw new Meteor.Error(416, "Requested Range Unit Not Satisfiable");
        }

      } else {
        // No range found
      }

    } else {
      // throw new Error('No request headers set for _parseRange function');
    }
  } else {
    throw new Error('No request object passed to _parseRange function');
  }

  return {
    start: 0,
    end: fileSize - 1,
    length: fileSize,
    size: fileSize,
    unit: 'bytes',
    partial: false
  };
};

/**
 * @method httpGetHandler
 * @private
 * @returns {any} response
 *
 * HTTP GET request handler
 */
httpGetHandler = function httpGetHandler(ref) {
  var self = this;
  // Once we have the file, we can test allow/deny validators
  // XXX: pass on the "share" query eg. ?share=342hkjh23ggj for shared url access?
  FS.Utility.validateAction(ref.collection._validators['download'], ref.file, self.userId /*, self.query.shareId*/);

  var storeName = ref.storeName;

  // If no storeName was specified, use the first defined storeName
  if (typeof storeName !== "string") {
    // No store handed, we default to primary store
    storeName = ref.collection.primaryStore.name;
  }

  // Get the storage reference
  var storage = ref.collection.storesLookup[storeName];

  if (!storage) {
    throw new Meteor.Error(404, "Not Found", 'There is no store "' + storeName + '"');
  }

  // Get the file
  var copyInfo = ref.file.copies[storeName];

  if (!copyInfo) {
    throw new Meteor.Error(404, "Not Found", 'This file was not stored in the ' + storeName + ' store');
  }

  // Set the content type for file
  if (typeof copyInfo.type === "string") {
    self.setContentType(copyInfo.type);
  } else {
    self.setContentType('application/octet-stream');
  }

  // Add 'Content-Disposition' header if requested a download/attachment URL
  if (typeof ref.download !== "undefined") {
    var filename = ref.filename || copyInfo.name;
    self.addHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  } else {
    self.addHeader('Content-Disposition', 'inline');
  }

  // Get the contents range from request
  var range = requestRange(self.request, copyInfo.size);

  // If a chunk/range was requested instead of the whole file, serve that'
  // Also set correct headers for partial request
  if (range.partial) {
    // Inform clients that we accept ranges for resumable chunked downloads
    self.setStatusCode(206, 'Partial Content');
    self.addHeader('Accept-Ranges', range.unit);
    self.addHeader('Content-Range', range.unit + ' ' + range.start + '-' + range.end + '/' + range.size);
  } else {
    self.setStatusCode(200, 'OK');
  }

  // Add any other global custom headers and collection-specific custom headers
  FS.Utility.each(getHeaders.concat(getHeadersByCollection[ref.collection.name] || []), function(header) {
    self.addHeader(header[0], header[1]);
  });

  // Inform clients about length (or chunk length in case of ranges)
  self.addHeader('Content-Length', range.length);

  // Last modified header (updatedAt from file info)
  self.addHeader('Last-Modified', copyInfo.updatedAt.toUTCString());

  if (FS.debug) console.log('Read file "' + (ref.filename || copyInfo.name) + '" ' + range.unit + ' ' + range.start + '-' + range.end + '/' + range.size);

  var readStream = storage.adapter.createReadStream(ref.file, {start: range.start, end: range.end});

  readStream.on('error', function(err) {
    // Send proper error message on get error
    if (err.message && err.statusCode) {
      self.Error(new Meteor.Error(err.statusCode, err.message));
    } else {
      self.Error(new Meteor.Error(503, 'Service unavailable'));
    }
  });

  readStream.pipe(self.createWriteStream());
};

httpPutInsertHandler = function httpPutInsertHandler(ref) {
  var self = this;
  var opts = FS.Utility.extend({}, self.query || {}, self.params || {});

  FS.debug && console.log("HTTP PUT (insert) handler");

  // Create the nice FS.File
  var fileObj = new FS.File();

  // Set its name
  fileObj.name(opts.filename || null);

  // Attach the readstream as the file's data
  fileObj.attachData(self.createReadStream(), {type: self.requestHeaders['content-type'] || 'application/octet-stream'});

  // Validate with insert allow/deny
  FS.Utility.validateAction(ref.collection.files._validators['insert'], file, self.userId);

  // Insert file into collection, triggering readStream storage
  ref.collection.insert(fileObj);

  // Send response
  self.setStatusCode(200);

  // Return the new file id
  return {_id: fileObj._id};
};

httpPutUpdateHandler = function httpPutUpdateHandler(ref) {
  var self = this;
  var opts = FS.Utility.extend({}, self.query || {}, self.params || {});

  var chunk = parseInt(opts.chunk, 10);
  if (isNaN(chunk)) chunk = 0;

  FS.debug && console.log("HTTP PUT (update) handler received chunk: ", chunk);

  // Validate with insert allow/deny; also mounts and retrieves the file
  FS.Utility.validateAction(ref.collection.files._validators['insert'], ref.file, self.userId);

  self.createReadStream().pipe( FS.TempStore.createWriteStream(ref.file, chunk) );

  // Send response
  self.setStatusCode(200);

  return { _id: ref.file._id, chunk: chunk };
};
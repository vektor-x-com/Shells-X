FROM php:8.2-apache

# sockets: needed by the traceroute console snippet (IP_TTL via socket_create).
# Not present by default in the official php:8.2-apache image.
RUN docker-php-ext-install sockets
